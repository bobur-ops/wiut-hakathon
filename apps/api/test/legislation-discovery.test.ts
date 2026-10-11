import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTriageText, parseUniqueSearch, relevanceForAct } from "../src/monitoring/legislation-discovery.js";

test("parses bounded latest Lex unique-search act rows, including negative document IDs", () => {
  const html = `<div class="dd-table__main-item"><a class="lx_link" href="/ru/docs/-8529453">Банк хизматлари истеъмолчилари</a><div class="dd-table__main-extra"><span class="badge">Решение Центрального банка, 09.10.2026</span><a href="/ru/pdfs/-8529453">PDF</a></div></div>`;
  assert.deepEqual(parseUniqueSearch(html), [{ lex_document_id:"-8529453", title:"Банк хизматлари истеъмолчилари", issuer_text:"Решение Центрального банка, 09.10.2026", published_at:"2026-10-09", official_url:"https://lex.uz/docs/-8529453", pdf_url:"https://lex.uz/pdffile/-8529453" }]);
});

test("keyword triage highlights fintech-related title/issuer matches without claiming applicability", () => {
  const result = relevanceForAct({ title:"Банк хизматлари истеъмолчилари", issuer_text:"Центральный банк" }, "commercial_bank", []);
  assert.equal(result.relevant,true);
  assert.ok(result.reasons.some(reason => reason.includes("banking")));
  assert.equal(result.reasons.length,2);
});

test("unrelated acts are not automatically marked relevant from organization type alone", () => {
  assert.deepEqual(relevanceForAct({ title:"Tax administration for irrigation districts", issuer_text:"Ministry of Water" }, "commercial_bank", []), { relevant:false, reasons:[] });
});

test("the reported Lex.uz act is a likely match from Uzbek Cyrillic metadata",()=>{
  const result=relevanceForAct({title:"Банк хизматлари истеъмолчилари билан ўзаро муносабатларни амалга оширишда тижорат банкларининг фаолиятига қўйиладиган минимал талаблар",issuer_text:"Ўзбекистон Республикаси Марказий банки"},
    "commercial_bank",["Retail and legal-entity bank accounts"]);
  assert.equal(result.relevant,true);
  assert.ok(result.reasons.includes("Keyword match: banking"));
  assert.ok(result.reasons.includes("Keyword match: customer-protection"));
});

test("triage supports Russian, Uzbek Cyrillic, Uzbek Latin apostrophe variants, and English",()=>{
  const cases=[
    ["Положение о защите потребителей банковских услуг","commercial_bank","bank accounts"],
    ["Банк хизматлари истеъмолчилари","commercial_bank","bank accounts"],
    ["Bank xizmatlari isteʼmolchilari huquqlarini himoya qilish","commercial_bank","bank accounts"],
    ["Banking customer protection and consumer rights","commercial_bank","bank accounts"],
    ["Consumer payments and digital finance","payment_organization","Payment services and transfers"],
    ["Защита персональных данных клиентов банка","commercial_bank","Personal data controller"],
  ] as const;
  for(const [title,organizationType,activity] of cases){
    assert.equal(relevanceForAct({title,issuer_text:null},organizationType,[activity]).relevant,true,`Expected match for ${title}`);
  }
  assert.equal(normalizeTriageText("TOʻLOV va To‘lov"),"to'lov va to'lov");
});

test("Lex language-specific links normalize to the same negative act identity",()=>{
  const html=["ru","uz","en"].map(lang=>`<div class="dd-table__main-item"><a class="lx_link" href="/${lang}/docs/-8529453">Act</a></div>`).join("");
  assert.deepEqual(parseUniqueSearch(html).map(act=>act.lex_document_id),["-8529453"]);
});
