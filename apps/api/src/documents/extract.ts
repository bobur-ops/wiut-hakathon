import { extractPagesMarkdownAsync } from "@firecrawl/pdf-inspector";
import * as cheerio from "cheerio";
import mammoth from "mammoth";

export type ExtractedSection = {
  sectionType: "DOCUMENT_METADATA" | "DOCUMENT_TITLE" | "CHAPTER" | "ARTICLE" | "PARAGRAPH" | "PAGE" | "SIGNATURE";
  heading: string | null;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  sourceReference: string | null;
  parentSectionIndex: number | null;
};

export type ExtractionResult = {
  sections: ExtractedSection[];
  metadata: Record<string, unknown>;
  warnings: string[];
};

export function normalizeExtractedText(text: string) {
  return text
    .normalize("NFC")
    .replace(/[\u00ad\u00a0\u202f]/g, (character) => character === "\u00ad" ? "" : " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function paragraphsToSections(text: string): ExtractedSection[] {
  return text
    .split(/\n{2,}/)
    .map((content) => content.trim())
    .filter(Boolean)
    .map((content, index) => ({
      sectionType: "PARAGRAPH" as const,
      heading: null,
      content,
      pageStart: null,
      pageEnd: null,
      sourceReference: `paragraph:${index + 1}`,
      parentSectionIndex: null,
    }));
}

export async function extractDocument(
  buffer: Buffer,
  mimeType: string,
  options: { declaredLanguage?: string | null } = {},
): Promise<ExtractionResult> {
  if (mimeType === "application/pdf") {
    const result = await extractPagesMarkdownAsync(buffer);
    const warnings: string[] = [];

    if (result.pagesNeedingOcr.length > 0) {
      warnings.push(
        `Some pages need OCR and were not text-extracted: ${result.pagesNeedingOcr.join(", ")}`,
      );
    }

    const sections = result.pages
      .map((page) => ({
        sectionType: "PAGE" as const,
        heading: `Page ${page.page + 1}`,
        content: page.markdown.trim(),
        pageStart: page.page + 1,
        pageEnd: page.page + 1,
        sourceReference: `page:${page.page + 1}`,
        parentSectionIndex: null,
      }))
      .filter((section) => section.content.length > 0);

    if (sections.length === 0) {
      throw new UnsupportedDocumentError(
        "No extractable text found. This may be a scanned PDF; OCR is not enabled.",
      );
    }

    return {
      sections,
      warnings,
      metadata: {
        pageCount: result.pages.length,
        pagesNeedingOcr: result.pagesNeedingOcr,
        pagesWithTables: result.pagesWithTables,
        pagesWithColumns: result.pagesWithColumns,
      },
    };
  }

  if (mimeType === "text/html") {
    const $ = cheerio.load(buffer.toString("utf8"));
    const legalBody = $("#divCont");
    if (!legalBody.length) {
      throw new UnsupportedDocumentError("Could not find the Lex.uz legal document body in this HTML page.");
    }

    const sections: ExtractedSection[] = [];
    let currentHeading: string | null = null;
    let currentChapterIndex: number | null = null;
    let currentArticleIndex: number | null = null;
    const contentClasses = [
      "ACT_FORM",
      "ACT_TITLE",
      "GRIF_PARLAMENT",
      "TEXT_HEADER_DEFAULT",
      "CLAUSE_DEFAULT",
      "ACT_TEXT",
      "SIGNATURE",
    ];

    legalBody.children().each((_, element) => {
      const classes = (element.attribs.class ?? "").split(/\s+/);
      const contentClass = contentClasses.find((name) => classes.includes(name));
      if (!contentClass) return;

      const textElement = $(element).children("[name]").first();
      const content = textElement.text().replace(/\s+/g, " ").trim();
      if (!content) return;

      if (contentClass === "TEXT_HEADER_DEFAULT" || contentClass === "CLAUSE_DEFAULT") {
        currentHeading = content;
      }

      const elementId = textElement.attr("name") ?? textElement.attr("id");
      const sectionIndex = sections.length;
      const sectionType: ExtractedSection["sectionType"] =
        contentClass === "ACT_FORM" || contentClass === "GRIF_PARLAMENT"
          ? "DOCUMENT_METADATA"
          : contentClass === "ACT_TITLE"
            ? "DOCUMENT_TITLE"
            : contentClass === "TEXT_HEADER_DEFAULT"
              ? "CHAPTER"
              : contentClass === "CLAUSE_DEFAULT"
                ? "ARTICLE"
                : contentClass === "SIGNATURE"
                  ? "SIGNATURE"
                  : "PARAGRAPH";
      const parentSectionIndex = sectionType === "ARTICLE"
        ? currentChapterIndex
        : sectionType === "PARAGRAPH"
          ? currentArticleIndex
          : null;

      sections.push({
        sectionType,
        heading: sectionType === "PARAGRAPH" ? currentHeading : null,
        content,
        pageStart: null,
        pageEnd: null,
        sourceReference: elementId ? `lex-element:${elementId}` : null,
        parentSectionIndex,
      });

      if (sectionType === "CHAPTER") currentChapterIndex = sectionIndex;
      if (sectionType === "ARTICLE") currentArticleIndex = sectionIndex;
    });

    if (!sections.some((section) => ["CHAPTER", "ARTICLE", "PARAGRAPH", "PAGE"].includes(section.sectionType))) {
      const originalPath = legalBody.find(".COMMENT_FOR_WARNING a[href]").first().attr("href");
      const originalUrl = originalPath && /^\/docs\/-?\d+$/.test(originalPath)
        ? `https://lex.uz${originalPath}` : null;
      throw new UnsupportedDocumentError(originalUrl
        ? `This Lex.uz language page contains no legal provisions. Import the original-language text instead: ${originalUrl}`
        : "No substantive legal text was found in the Lex.uz page (a title or signature alone is insufficient).");
    }

    return {
      sections,
      warnings: [],
      metadata: {
        title: $("title").text().replace(/\s+/g, " ").trim(),
        sourceFormat: "lex.uz-html",
        htmlLanguage: $("html").attr("lang") ?? null,
        declaredLanguage: options.declaredLanguage ?? null,
        sectionCount: sections.length,
      },
    };
  }

  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    const sections = paragraphsToSections(result.value);
    if (sections.length === 0) {
      throw new UnsupportedDocumentError("No extractable text found in DOCX.");
    }
    return {
      sections,
      warnings: result.messages.map((message) => message.message),
      metadata: { paragraphCount: sections.length },
    };
  }

  if (mimeType === "text/plain") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
    } catch {
      throw new UnsupportedDocumentError("Text files must use UTF-8 encoding.");
    }
    const pageTexts = text.includes("\f") ? text.split("\f") : [text];
    const sections = pageTexts.flatMap((pageText, pageIndex) =>
      paragraphsToSections(pageText).map((section) => ({
        ...section,
        sourceReference: pageTexts.length > 1
          ? `page:${pageIndex + 1}:${section.sourceReference}`
          : section.sourceReference,
        heading: pageTexts.length > 1 ? `Page ${pageIndex + 1}` : null,
        pageStart: pageTexts.length > 1 ? pageIndex + 1 : null,
        pageEnd: pageTexts.length > 1 ? pageIndex + 1 : null,
      })),
    );
    if (sections.length === 0) {
      throw new UnsupportedDocumentError("The text file is empty.");
    }
    return { sections, warnings: [], metadata: {} };
  }

  throw new UnsupportedDocumentError("Unsupported document type.");
}

export class UnsupportedDocumentError extends Error {
  readonly code = "UNSUPPORTED_DOCUMENT";
}
