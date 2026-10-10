import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import * as cheerio from "cheerio";

const configuredMaxSize = Number(process.env.REMOTE_DOCUMENT_MAX_BYTES ?? 20 * 1024 * 1024);
const MAX_FILE_SIZE = Number.isSafeInteger(configuredMaxSize) && configuredMaxSize > 0
  ? configuredMaxSize
  : 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const allowedHosts = new Set(
  (process.env.REMOTE_DOCUMENT_HOSTS ?? "lex.uz,www.lex.uz,cbu.uz,www.cbu.uz")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

export class RemoteDocumentError extends Error {}

export async function discoverLexDocumentVersions(input: string) {
  let initial: URL;
  try {
    initial = new URL(input);
  } catch {
    throw new RemoteDocumentError("Provide a valid Lex.uz document URL.");
  }
  if (!isLexDocumentPage(initial)) {
    throw new RemoteDocumentError("Bulk version import only supports Lex.uz /docs/{id} pages.");
  }
  const downloaded = await downloadRemoteDocument(initial.toString());
  const $ = cheerio.load(downloaded.contents.toString("utf8"));
  const versions = new Map<string, { url: string; revisionDate: string | null; label: string }>();
  const canonicalUrl = new URL(initial.pathname, initial.origin).toString();
  versions.set(canonicalUrl, { url: canonicalUrl, revisionDate: null, label: "Current version" });

  $(".lx_date_link").each((_, element) => {
    const onclick = $(element).attr("onclick") ?? "";
    const match = onclick.match(/lxOpenUrl\(['"](\/docs\/\d+\?ONDATE=(\d{2}\.\d{2}\.\d{4}))['"]\)/);
    const path = match?.[1];
    const dateText = match?.[2];
    if (!path || !dateText || new URL(path, initial.origin).pathname !== initial.pathname) return;
    const [day, month, year] = dateText.split(".");
    const revisionDate = `${year}-${month}-${day}`;
    const url = new URL(path, initial.origin).toString();
    versions.set(url, { url, revisionDate, label: `Revision ${revisionDate}` });
  });

  if (initial.searchParams.has("ONDATE")) {
    const dateText = initial.searchParams.get("ONDATE")!;
    const dateMatch = dateText.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const isoDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : "";
    const parsedDate = new Date(isoDate);
    if (isoDate && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === isoDate) {
      versions.set(initial.toString(), {
        url: initial.toString(),
        revisionDate: isoDate,
        label: `Revision ${isoDate}`,
      });
    }
  }

  return {
    title: $("title").text().replace(/\s+/g, " ").trim(),
    versions: [...versions.values()].sort((left, right) =>
      (left.revisionDate ?? "9999-12-31").localeCompare(right.revisionDate ?? "9999-12-31")),
  };
}

function isLexDocumentPage(url: URL) {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  return hostname === "lex.uz" && /^\/docs\/\d+\/?$/.test(url.pathname);
}

async function validateRemoteUrl(url: URL) {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== "" ||
    isIP(hostname) !== 0 ||
    !allowedHosts.has(hostname)
  ) {
    throw new RemoteDocumentError("URL host is not an allowed HTTPS document source.");
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => ipaddr.parse(address).range() !== "unicast")) {
    throw new RemoteDocumentError("The source host resolved to a non-public IP address.");
  }
}

export async function downloadRemoteDocument(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new RemoteDocumentError("Provide a valid document URL.");
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await validateRemoteUrl(url);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: {
        accept: "application/pdf, text/html;q=0.9, application/octet-stream;q=0.8",
        "user-agent": "RegCheckUZ-document-fetch/1.0",
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === MAX_REDIRECTS) {
        throw new RemoteDocumentError("The source redirected too many times or omitted a redirect target.");
      }
      url = new URL(location, url);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new RemoteDocumentError(`The source returned HTTP ${response.status}.`);
    }

    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const isPdf = contentType === "application/pdf" || contentType === "application/octet-stream";
    const isHtml = contentType === "text/html" && isLexDocumentPage(url);
    if (!isPdf && !isHtml) {
      await response.body?.cancel();
      throw new RemoteDocumentError("The source must return a PDF or an allowlisted Lex.uz /docs/{id} page.");
    }

    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_FILE_SIZE) {
      await response.body?.cancel();
      throw new RemoteDocumentError("Remote document exceeds the configured size limit.");
    }

    if (!response.body) throw new RemoteDocumentError("The source returned an empty response.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_SIZE) {
        await reader.cancel();
        throw new RemoteDocumentError("Remote document exceeds the configured size limit.");
      }
      chunks.push(value);
    }

    const contents = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    if (isPdf && !contents.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
      throw new RemoteDocumentError("Downloaded content is not a valid PDF file.");
    }
    if (isHtml && !/<(?:!doctype\s+html|html)\b/i.test(contents.toString("utf8", 0, 1024))) {
      throw new RemoteDocumentError("Downloaded content is not a valid HTML document page.");
    }

    const pathPart = url.pathname.split("/").filter(Boolean).at(-1) ?? "document";
    const safeName = pathPart.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    const extension = isHtml ? ".html" : ".pdf";
    const filename = `${safeName.toLowerCase().endsWith(extension) ? safeName.slice(0, -extension.length) : safeName}${extension}`;

    return {
      contents,
      filename,
      mimeType: isHtml ? "text/html" : "application/pdf",
      sourceUrl: url.toString(),
    };
  }

  throw new RemoteDocumentError("Could not download the remote document.");
}
