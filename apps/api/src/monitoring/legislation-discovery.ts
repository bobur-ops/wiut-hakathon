import { randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { pool } from "../db.js";
import type { PgBoss } from "pg-boss";
import { LEGISLATION_IMPORT_QUEUE } from "../documents/queue.js";
import { queueNotification } from "../notifications/service.js";

const LIST_URL = "https://lex.uz/ru/search/unique";
const MAX_ITEMS_PER_SCAN = 50;
const MAX_AUTO_IMPORTS_PER_SCAN = 3;
const TERMS: Array<[string, RegExp]> = [
  ["banking", /банк|банков|\bbank\b|банк\s+(?:фаолияти|хизмат)|bank(?:ing)?\s+(?:activity|services?)/u],
  ["payments", /платеж|платёж|\bpayments?\b|тўлов|тулов|тўловлар|туловлар|to['’ʻʼ]?lov|расч[её]т|денежн.{0,12}перевод/u],
  ["fintech", /финтех|финансов.{0,12}технолог|финансов.{0,12}технол|электронн.{0,12}ден|электрон.{0,12}плат|цифров.{0,12}финанс|\bfintech\b|financial technolog|digital financ|electronic money|electronic payment/u],
  ["customer-protection", /потребител.{0,20}(?:финанс|банк|услуг)|защит.{0,20}(?:прав|потребител)|истеъмолчи|iste['’ʻʼ]?molchi|consumer.{0,24}(?:protect|right|service|bank)|customer.{0,24}(?:protect|right|service|bank)|minimum.{0,16}requirement/u],
  ["personal-data", /персональн.{0,12}данн|шахсий\s+маълумот|shaxsiy\s+ma['’ʻʼ]?lumot|personal data|data protection/u],
  ["aml", /легализац.{0,20}доход|отмывани|терроризм|финансирован.{0,20}оруж|жиноий\s+даромад|jinoiy\s+daromad|anti.?money laundering|money laundering|terrorist financing|proceeds of crime/u],
  ["cybersecurity", /кибербезопас|информационн.{0,12}безопас|киберхавфсиз|kiberxavfsiz|ахборот хавфсиз|information security|cyber ?security/u],
  ["lending", /кредит|микрофинанс|заём|заем|қарз|кредитлаш|\bcredit\b|\bloans?\b|lending|microfinance/u],
];

export function normalizeTriageText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("uz-UZ")
    .replace(/[ʻʼ‘’`´]/g,"'").replace(/[oO]'/g,"o'").replace(/[gG]'/g,"g'")
    .replace(/[_-]+/g," ").replace(/\s+/g," ").trim();
}

export interface DiscoveredAct {
  lex_document_id: string; title: string; issuer_text: string | null; published_at: string | null;
  official_url: string; pdf_url: string | null;
}

export function parseUniqueSearch(html: string): DiscoveredAct[] {
  const $ = cheerio.load(html);
  const rows: DiscoveredAct[] = [];
  const seen = new Set<string>();
  $(".dd-table__main-item").each((_, row) => {
    if (rows.length >= MAX_ITEMS_PER_SCAN) return;
    const link = $(row).find('a.lx_link[href*="/docs/"]').first();
    const href = link.attr("href") ?? "";
    const match = href.match(/^\/(?:(?:ru|uz|en)\/)?docs\/(-?\d+)\/?$/i);
    if (!match) return;
    const lex_document_id = match[1]!;
    if (seen.has(lex_document_id)) return;
    seen.add(lex_document_id);
    const pdfPath = $(row).find('a[href*="/pdfs/"]').first().attr("href");
    const issuer = $(row).find(".dd-table__main-extra .badge").first().text().replace(/\s+/g," ").trim();
    const dateMatch = issuer.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    rows.push({ lex_document_id, title: link.text().replace(/\s+/g," ").trim(), issuer_text: issuer || null,
      published_at: dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null,
      official_url: `https://lex.uz/docs/${lex_document_id}`,
      // The language-specific /pdfs/ viewer returns HTML; its embedded
      // /pdffile/{id} endpoint is the actual PDF download.
      pdf_url: pdfPath ? `https://lex.uz/pdffile/${lex_document_id}` : null });
  });
  return rows;
}

export function relevanceForAct(act: Pick<DiscoveredAct,"title"|"issuer_text">, organizationType: string, activities: string[]) {
  // Require a domain signal in both the act metadata and the organization's
  // declared type/activities. Profile words alone never make an act relevant.
  const profile = normalizeTriageText(`${organizationType} ${activities.join(" ")}`);
  const actText = normalizeTriageText(`${act.title} ${act.issuer_text ?? ""}`);
  const bankSignal=/банк|банков|\bbank(?:ing)?\b/u;
  const matches = TERMS.filter(([name,pattern]) => {
    const profileMatch=name==="customer-protection" ? pattern.test(profile)||bankSignal.test(profile) : pattern.test(profile);
    return profileMatch&&pattern.test(actText);
  }).map(([name]) => name);
  return { relevant: matches.length > 0, reasons: matches.map(name => `Keyword match: ${name}`) };
}

export async function queueLikelyActImport(organizationId: string,itemId: string,boss: PgBoss) {
  const claimed = await pool.query(`UPDATE legislation_inbox SET status='QUEUED',status_note=NULL
    WHERE organization_id=$1 AND item_id=$2 AND status='LIKELY_RELEVANT' RETURNING item_id`,[organizationId,itemId]);
  if (!claimed.rowCount) return false;
  const job = await boss.send(LEGISLATION_IMPORT_QUEUE,{organizationId,itemId},
    {singletonKey:`${organizationId}:${itemId}`,singletonSeconds:60,retryLimit:2,retryDelay:30});
  if (!job) {
    await pool.query(`UPDATE legislation_inbox SET status='LIKELY_RELEVANT',status_note='Waiting for the background worker queue.'
      WHERE organization_id=$1 AND item_id=$2 AND status='QUEUED'`,[organizationId,itemId]);
    return false;
  }
  return true;
}

export async function discoverNewLegislation(boss: PgBoss, fetcher: typeof fetch = fetch) {
  const run = await pool.query<{id:string}>("INSERT INTO legislation_discovery_runs(status) VALUES ('RUNNING') RETURNING id");
  try {
  const response = await fetcher(LIST_URL,{ signal: AbortSignal.timeout(20_000), headers: { accept:"text/html", "user-agent":"RegCheckUZ-legislation-discovery/1.0" } });
  if (!response.ok) throw new Error(`Lex.uz new-legislation listing returned HTTP ${response.status}.`);
  const html = await response.text();
  const acts = parseUniqueSearch(html);
  if (!acts.length) throw new Error("Lex.uz listing returned no parseable act rows; discovery cursor was not advanced.");
  const organizations = await pool.query<{id:string;organization_type:string;activities:string[]}>("SELECT id,organization_type,activities FROM organizations");
  let inserted = 0;
  for (const act of acts) {
    const id = randomUUID();
    const result = await pool.query(`INSERT INTO legislation_discovery_items
      (id,lex_document_id,title,issuer_text,published_at,official_url,pdf_url)
      VALUES ($1,$2,$3,$4,$5::date,$6,$7) ON CONFLICT (lex_document_id) DO NOTHING RETURNING id`,
    [id,act.lex_document_id,act.title,act.issuer_text,act.published_at,act.official_url,act.pdf_url]);
    const itemId = result.rows[0]?.id ?? (await pool.query<{id:string}>("SELECT id FROM legislation_discovery_items WHERE lex_document_id=$1",[act.lex_document_id])).rows[0]?.id;
    if (!itemId) continue;
    if (result.rowCount) inserted++;
    for (const organization of organizations.rows) {
      const relevance = relevanceForAct(act,organization.organization_type,organization.activities ?? []);
      await pool.query(`INSERT INTO legislation_inbox(organization_id,item_id,status,relevance_reasons)
        VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (organization_id,item_id) DO UPDATE SET
          relevance_reasons=EXCLUDED.relevance_reasons,
          status=CASE
            WHEN legislation_inbox.review_decision IS NOT NULL OR legislation_inbox.reviewed_at IS NOT NULL THEN legislation_inbox.status
            WHEN legislation_inbox.status IN ('QUEUED','IMPORTING','IMPORTED','IMPORT_FAILED','NOT_RELEVANT') THEN legislation_inbox.status
            ELSE EXCLUDED.status END`,
      [organization.id,itemId,relevance.relevant?"LIKELY_RELEVANT":"NEW",JSON.stringify(relevance.reasons)]);
      if (relevance.relevant) try { await queueNotification({organizationId:organization.id,eventKey:`new-legislation:${itemId}`,type:"LIKELY_RELEVANT_LEGISLATION",
        subject:"New legislation may be relevant to your organization",body:`A Lex.uz keyword/profile match suggests this act may be relevant: “${act.title}”. This is a triage signal, not a legal applicability decision. A preliminary analysis may run automatically; human review is required.\n\nReview new legislation: ${(process.env.WEB_APP_URL??"http://localhost:5173").replace(/\/$/,"")}/updates`},boss); }
      catch(error) { console.error("Could not queue new-legislation email",error); }
    }
  }
  // Retry queueing for likely acts discovered while the worker/API queue was
  // temporarily unavailable; active imports are idempotently ignored by worker.
  const pending = await pool.query(`SELECT inbox.organization_id,inbox.item_id FROM legislation_inbox inbox
    JOIN legislation_discovery_items item ON item.id=inbox.item_id WHERE inbox.status='LIKELY_RELEVANT'
    ORDER BY item.discovered_at LIMIT $1`,[MAX_AUTO_IMPORTS_PER_SCAN]);
  for (const row of pending.rows) await queueLikelyActImport(row.organization_id,row.item_id,boss);
  await pool.query("UPDATE legislation_discovery_runs SET status='COMPLETED',completed_at=NOW(),scanned_count=$2,inserted_count=$3 WHERE id=$1",[run.rows[0]!.id,acts.length,inserted]);
  return { scanned: acts.length, inserted };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0,1000) : "Lex.uz discovery failed.";
    await pool.query("UPDATE legislation_discovery_runs SET status='FAILED',completed_at=NOW(),error_message=$2 WHERE id=$1",[run.rows[0]!.id,message]);
    throw error;
  }
}

export { LIST_URL as LEGISLATION_DISCOVERY_URL };
