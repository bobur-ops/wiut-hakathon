export type ComparableSection = {
  section_type: string;
  source_reference: string | null;
  normalized_content: string;
  parent_source_reference: string | null;
  parent_content: string | null;
};

export type RegulationChange = {
  change_type: "ADDED" | "REMOVED" | "MODIFIED";
  source_reference: string;
  article_reference: string | null;
  match_method?: "stable-source-reference" | "article-and-text-similarity";
  needs_review?: boolean;
  previous_text?: string;
  new_text?: string;
};

function articleNumber(section: ComparableSection) {
  const articleText = section.section_type === "ARTICLE" ? section.normalized_content : section.parent_content;
  return articleText?.match(/^Статья\s+(\d+(?:[.-]\d+)*)/iu)?.[1] ?? null;
}

function sameArticle(previous: ComparableSection, current: ComparableSection) {
  const previousArticle = articleNumber(previous);
  const currentArticle = articleNumber(current);
  if (previousArticle !== null && currentArticle !== null) return previousArticle === currentArticle;
  return previous.parent_source_reference === current.parent_source_reference;
}

function structuralKey(section: ComparableSection) {
  const article = articleNumber(section);
  if (!article) return null;
  return `${article}:${section.section_type}`;
}

function similarity(left: string, right: string) {
  const tokenize = (value: string) => new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const a = tokenize(left);
  const b = tokenize(right);
  if (!a.size || !b.size) return left === right ? 1 : 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function compareSections(
  previousSections: ComparableSection[],
  currentSections: ComparableSection[],
) {
  const previousByReference = new Map(
    previousSections
      .filter((section): section is ComparableSection & { source_reference: string } => Boolean(section.source_reference))
      .map((section) => [section.source_reference, section]),
  );
  const currentByReference = new Map(
    currentSections
      .filter((section): section is ComparableSection & { source_reference: string } => Boolean(section.source_reference))
      .map((section) => [section.source_reference, section]),
  );
  const changes: RegulationChange[] = [];
  const unmatchedPrevious = new Map(previousByReference);
  const unmatchedCurrent = new Map(currentByReference);

  // First match stable Lex element IDs. A parent ID changing alone is not a legal text change.
  for (const [reference, previous] of previousByReference) {
    const current = currentByReference.get(reference);
    if (!current) continue;
    unmatchedPrevious.delete(reference);
    unmatchedCurrent.delete(reference);
    if (previous.section_type === current.section_type && previous.normalized_content === current.normalized_content && sameArticle(previous, current)) continue;
    changes.push({
      change_type: "MODIFIED",
      source_reference: reference,
      article_reference: current.section_type === "ARTICLE"
        ? reference
        : current.parent_source_reference ?? previous.parent_source_reference,
      match_method: "stable-source-reference",
      previous_text: previous.normalized_content,
      new_text: current.normalized_content,
    });
  }

  // Reserve exact text matches across the article before considering edits.
  for (const [previousReference, previous] of unmatchedPrevious) {
    const key = structuralKey(previous);
    if (!key) continue;
    const exact = [...unmatchedCurrent].find(([, current]) =>
      structuralKey(current) === key && current.normalized_content === previous.normalized_content);
    if (!exact) continue;
    unmatchedPrevious.delete(previousReference);
    unmatchedCurrent.delete(exact[0]);
  }

  // Evaluate all remaining pairs together. Only accept reciprocal, unique best
  // matches: neither side may have an equally good alternative. No forced rewrites.
  const candidates = [...unmatchedPrevious].flatMap(([previousReference, previous]) => {
    const key = structuralKey(previous);
    if (!key) return [];
    return [...unmatchedCurrent]
      .filter(([, current]) => structuralKey(current) === key)
      .map(([currentReference, current]) => ({
        previousReference, currentReference, previous, current,
        score: similarity(previous.normalized_content, current.normalized_content),
      }));
  });
  const ambiguousPrevious = new Set<string>();
  const ambiguousCurrent = new Set<string>();
  const previousBest = new Map<string, { score: number; count: number }>();
  const currentBest = new Map<string, { score: number; count: number }>();
  const recordBest = (best: Map<string, { score: number; count: number }>, reference: string, score: number) => {
    const existing = best.get(reference);
    if (!existing || score > existing.score) best.set(reference, { score, count: 1 });
    else if (score === existing.score) existing.count++;
  };
  for (const candidate of candidates) {
    recordBest(previousBest, candidate.previousReference, candidate.score);
    recordBest(currentBest, candidate.currentReference, candidate.score);
  }
  for (const candidate of candidates) {
    const leftBest = previousBest.get(candidate.previousReference)!;
    const rightBest = currentBest.get(candidate.currentReference)!;
    if (candidate.score < 0.16 || leftBest.score !== candidate.score || rightBest.score !== candidate.score ||
      leftBest.count !== 1 || rightBest.count !== 1) {
      ambiguousPrevious.add(candidate.previousReference);
      ambiguousCurrent.add(candidate.currentReference);
      continue;
    }
    unmatchedPrevious.delete(candidate.previousReference);
    unmatchedCurrent.delete(candidate.currentReference);
    changes.push({
      change_type: "MODIFIED",
      source_reference: candidate.currentReference,
      article_reference: candidate.current.section_type === "ARTICLE"
        ? candidate.currentReference
        : candidate.current.parent_source_reference ?? candidate.previous.parent_source_reference,
      match_method: "article-and-text-similarity",
      needs_review: true,
      previous_text: candidate.previous.normalized_content,
      new_text: candidate.current.normalized_content,
    });
  }

  for (const [reference, previous] of unmatchedPrevious) {
    changes.push({
      change_type: "REMOVED",
      source_reference: reference,
      article_reference: previous.section_type === "ARTICLE" ? reference : previous.parent_source_reference,
      previous_text: previous.normalized_content,
      needs_review: ambiguousPrevious.has(reference),
    });
  }

  for (const [reference, current] of unmatchedCurrent) {
    changes.push({
      change_type: "ADDED",
      source_reference: reference,
      article_reference: current.section_type === "ARTICLE" ? reference : current.parent_source_reference,
      new_text: current.normalized_content,
      needs_review: ambiguousCurrent.has(reference),
    });
  }

  const matchMethods = [...new Set(changes.filter((change) => change.change_type === "MODIFIED").map((change) => change.match_method))];
  return {
    summary: {
      added: changes.filter((change) => change.change_type === "ADDED").length,
      removed: changes.filter((change) => change.change_type === "REMOVED").length,
      modified: changes.filter((change) => change.change_type === "MODIFIED").length,
      matched_by: matchMethods.length ? matchMethods.join("+") : "stable-source-reference",
    },
    changes,
  };
}
