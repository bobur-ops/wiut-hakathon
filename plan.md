# RegCheck UZ
## AI-Powered FinTech Regulatory Compliance Platform
### MVP Technical Specification | FinTech Hackathon 2026

**Version:** 1.0  
**Development window:** 23 hours  
**Hackathon track:** FinTech / AI in Finance  
**Participation mode:** Startup  
**Primary market:** Regulated financial institutions and fintech businesses in Uzbekistan  
**Primary users:** Compliance officers, legal departments, internal auditors and risk-management teams  
**Data policy:** Synthetic organization documents and properly sourced public regulatory materials only

---

# 1. Executive Summary

RegCheck UZ is an AI-powered regulatory compliance platform that helps Uzbekistan's banks and fintech businesses identify discrepancies between their internal policies and applicable financial-sector regulations.

The system combines regulatory document processing, retrieval, obligation extraction, policy matching, AI-assisted analysis, and human approval workflows.

It supports two primary use cases.

**Use Case A: Initial Compliance Assessment**

A regulated organization uploads its internal policies and provides information about its products and business activities. The platform compares these policies with its indexed regulatory knowledge base, identifies potential discrepancies, and prepares an evidence-backed compliance assessment.

**Use Case B: Regulatory Change Impact Analysis**

When an existing regulation is amended or a new regulation is introduced, the platform identifies the affected requirements, determines which internal policies may need review, and generates proposed corrective actions.

The platform does not declare an organization legally compliant or non-compliant. Its findings are recommendations for qualified compliance officers to verify.

## 1.1 Problem Statement

Regulated financial organizations and fintech businesses must continuously maintain internal procedures that reflect the rules applicable to their products, activities, and legal-entity type.

The process can involve:

- Reading lengthy regulatory documents.
- Understanding amendments and effective dates.
- Determining which obligations apply to specific financial services, products, and business activities.
- Locating related internal policies.
- Comparing regulatory requirements with existing procedures.
- Identifying missing or outdated provisions.
- Preparing reports for management.
- Recording evidence of compliance reviews.

Manual execution can be slow, repetitive, and difficult to audit.

RegCheck UZ aims to reduce the time needed to prepare these assessments while making conclusions traceable to source documents.

## 1.2 Value Proposition

**Turn financial-sector regulations and internal policy documents into evidence-backed, reviewable compliance assessments.**

The product's value comes from connecting three types of information:

1. Regulatory obligations.
2. The organization's documented policies and business activities.
3. Compliance assessment findings and reviewer decisions.

A successful MVP must demonstrate this connection through working software.

## 1.3 Hackathon Success Definition

The MVP is successful when an independent user can:

1. Access the publicly deployed web application.
2. Create or open a fictional regulated-organization workspace.
3. Upload a previously unseen internal policy.
4. Run an assessment against real, indexed regulatory requirements.
5. See meaningful findings supported by exact document excerpts.
6. Understand why each finding was generated.
7. Approve, reject, or request further review of a finding.
8. Inspect the audit history.
9. Upload a new regulation and run an impact assessment.
10. Repeat the workflow with another input without changing the source code.

---

# 2. Scope and Priorities

## 2.1 Regulatory Scope

The initial regulatory corpus covers multiple fintech and financial-services domains rather than defining the product around AML/KYC alone. The MVP should curate a manageable, manually verified set of source documents across relevant domains and disclose exactly which organizations and provisions are covered.

Suggested domains:

- Payments and payment systems.
- Banking and prudential requirements.
- Payment services, payment organizations, and licensing.
- Electronic money and digital financial services.
- Customer/user protection and service-provider obligations.
- Governance, operational risk, and outsourcing.
- Information security, cybersecurity, and data protection.
- AML/KYC and customer due diligence.

**Initial source examples:**

- Uzbekistan's Law No. ZRU-578, "On Payments and Payment Systems," including relevant amendments: https://lex.uz/docs/4575788
- Uzbekistan's rules governing internal controls against money laundering and terrorism financing in commercial banks, registered under No. 2886: https://lex.uz/ru/acts/3212192

These are examples for a curated initial corpus, not a claim of complete coverage. Verify each source, covered entity types, selected provisions, version, and effective dates as of the assessment date.

## 2.2 Feature Priorities

| Feature | Priority |
|---|---|
| Fictional regulated-organization workspace | P0 |
| Internal policy PDF upload | P0 |
| Regulatory document corpus | P0 |
| Allowlisted remote PDF and Lex.uz legal-page ingestion | P0 |
| Structured text extraction | P0 |
| Regulatory obligation extraction | P0 |
| Initial compliance assessment | P0 |
| Evidence-backed explanations | P0 |
| Findings dashboard | P0 |
| Human approval/rejection | P0 |
| Audit history | P0 |
| Public deployment | P0 |
| Evaluation dataset and report | P0 |
| New regulation upload | P1 |
| Regulatory impact analysis | P1 |
| Side-by-side regulation version comparison | P1 |
| Export assessment report | P2 |
| Scheduled monitoring of a small allowlist of official sources | P1 |
| Full authentication and organization management | P2 |
| OCR for scanned documents | P2 |

P0 features are mandatory. P1 features are important and should follow once the initial workflow is reliable. P2 features can be excluded from the 23-hour build. For the MVP, regulatory monitoring is deliberately narrow: scheduled checks of a small, explicitly configured set of official source pages/documents, not comprehensive monitoring of every regulatory website.

---

# 3. User Roles

## 3.1 Compliance Officer

The primary user.

Can:

- Upload internal policies.
- Review indexed regulations.
- Start assessments.
- Inspect findings and evidence.
- Create remediation tasks.
- Approve or reject findings.
- Add review notes.
- View assessment history.

## 3.2 Compliance Manager

Responsible for oversight.

Can:

- View all assessments.
- Review outstanding findings.
- Inspect approval history.
- Assign responsibility.
- Monitor unresolved issues.

For the hackathon, both roles may share a simplified interface.

## 3.3 System Administrator

Maintains regulatory reference documents and technical configuration.

Can:

- Import regulations.
- Maintain their metadata and versions.
- Review extracted obligations.
- Manage processing failures.
- Inspect system logs.

A production release requires role-based permissions. The public hackathon demo can use isolated fictional workspaces without enterprise authentication.

---

# 4. Core Workflow A: Initial Compliance Assessment

This is the primary product workflow.

## Step 1: Organization Profile

The user opens a regulated-organization workspace.

The organization profile includes:

- Organization name.
- Organization type.
- Country and regulatory jurisdiction.
- Business activities and fintech domains.
- Available financial products and services.
- Relevant departments.
- Preferred document language.

Example:

**Organization name:** DemoFintech UZ

**Organization type:** Payment service provider

**Activities:**

- Payment processing.
- E-wallets and electronic money.
- Digital customer onboarding.
- Merchant acquiring.
- Domestic transfers.
- Banking partnerships.

**Departments:**

- Compliance.
- Legal.
- Risk Management.
- Retail Operations.
- AML Monitoring.

These details must influence applicability analysis rather than serving as decorative metadata. Support other organization types, including commercial banks, payment organizations, electronic-money providers, and other regulated fintech businesses.

## Step 2: Upload Internal Policies

The user uploads one or more documents.

Supported formats:

- PDF with extractable text.
- DOCX.
- TXT.

Recommended limits for the MVP:

- Maximum 5 MB per file.
- Maximum 20 pages per document.
- Maximum 5 documents per assessment.

If a document is scanned and contains no usable text, the system must report that extraction is unsupported instead of pretending it was analyzed.

Each uploaded document should store:

- Document identifier.
- File name.
- Document type.
- Language.
- Version or revision date, if known.
- Upload timestamp.
- Content hash.
- Processing status.

## Step 3: Document Processing

After upload, the backend:

1. Validates file type and size.
2. Extracts document text.
3. Preserves page boundaries.
4. Identifies headings and sections when possible.
5. Splits text into logical passages.
6. Assigns stable passage identifiers.
7. Stores passages and their locations.
8. Makes them searchable.

The system should prioritize section-aware splitting over arbitrary character-based chunks.

Document structure matters because a finding must refer to a specific policy clause.

## Step 4: Regulatory Applicability

The system reads the organization profile and retrieves potentially relevant regulatory obligations.

For each obligation, it determines whether the organization's declared activities and legal entity type fall within its scope.

Possible classifications:

- Applicable.
- Not applicable.
- Applicability uncertain.

The AI must explain its applicability determination.

An uncertain result should be sent for human review.

## Step 5: Policy Comparison

For each applicable obligation:

1. Retrieve potentially related internal policy passages.
2. Compare the regulatory requirement against those passages.
3. Identify whether documentary evidence supports the requirement.
4. Detect explicit contradictions or missing documentary evidence.
5. Produce a structured finding.
6. Attach exact source references.

The system must avoid treating the absence of a matching paragraph as definitive proof of a violation.

## Step 6: Assessment Results

The dashboard displays:

- Number of obligations assessed.
- Number with supporting policy evidence.
- Number with potential conflicts.
- Number with missing evidence.
- Number requiring human interpretation.
- Number classified as not applicable.

These numbers must be calculated from actual stored findings.

The dashboard must distinguish between AI-generated findings and human-reviewed findings.

## Step 7: Human Review

A compliance officer reviews the findings.

Available actions:

- Confirm potential gap.
- Reject finding.
- Mark as requiring additional evidence.
- Add a review note.
- Assign a remediation task.

Every action is recorded in the audit history.

---

# 5. Core Workflow B: Regulatory Change Impact Analysis

This workflow handles amendments and new regulations.

The MVP supports both manual import and scheduled monitoring of a small allowlist of official sources. Monitoring detects candidate changes; it does not make unverified legal updates authoritative or silently replace the active regulation version.

## Step 0: Scheduled Source Monitoring

An isolated backend worker runs configurable scheduled checks against approved official source URLs (initially a narrowly scoped set from CBU and Lex.uz, subject to access and usage terms). It records each check and uses available stable identifiers, publication metadata, ETag/Last-Modified headers, or content hashes to detect possible updates. Respect source terms, rate limits, and access policies; do not bypass access controls.

When a candidate change is detected, create a pending update for administrator review. Preserve the source URL, retrieval timestamp, content hash, and available source metadata. Do not overwrite a verified version, infer missing legal metadata, or present an unverified candidate as current. Surface fetch failures and stale-source status rather than implying that monitoring succeeded.

## Step 1: Import Regulation

The user uploads a regulatory document, enters its metadata and text, or supplies an official source URL. For allowlisted sources, the backend fetches supported PDF files or Lex.uz `/docs/{id}` pages and sends them through the same background ingestion pipeline. HTML extraction must target the legal document body, not navigation or controls.

Required fields:

- Regulation title.
- Issuing authority.
- Document number, if available.
- Publication or registration date, if known.
- Effective date, if known.
- Document file, text, or supported official source URL.

For Lex.uz `/docs/{id}` pages, extract the legal body from the HTML (including headings and article/paragraph boundaries), not navigation, menus, or page controls. Preserve the requested URL, selected revision/date parameters, retrieval timestamp, content hash, page title, language when detectable, and stable Lex element IDs as source references. Never treat the page's current presentation as proof that a version is legally applicable without verifying its metadata and effective dates.

Optional fields:

- Source URL.
- Superseded regulation or version.
- Relevant fintech/regulatory domain and covered entity types.

Unknown legal metadata must remain unknown rather than being generated by the model.

## Step 2: Extract Obligations

The AI identifies:

- Newly introduced obligations.
- Modified requirements.
- Removed requirements, if the prior version is available.
- Deadlines.
- Effective dates.
- Affected activities.
- Required actions.

The system must distinguish between a substantive obligation and general explanatory legal text.

## Step 3: Version Comparison

When both previous and new versions are available, compare their obligation structures.

Expected classifications:

- Added.
- Modified.
- Removed.
- Unchanged.
- Unable to determine.

Every change must include the relevant old and new source references.

When only the new version exists, the system can perform policy impact analysis but must not claim to have identified the complete set of amendments.

## Step 4: Impact Analysis

For each new or modified obligation:

1. Determine whether the organization's activities and entity type are in scope.
2. Search existing internal policies for related provisions.
3. Compare the new requirement with current policy evidence.
4. Identify possible gaps.
5. Suggest affected departments.
6. Recommend review or remediation actions.

## Step 5: Findings and Review

The user receives a structured impact report with reviewable findings.

The report is saved and becomes part of the organization's assessment history.

---

# 6. Regulatory Knowledge Base

The regulatory knowledge base is a critical component.

It should store regulations as structured, versioned documents rather than treating all legislation as one large text file.

## 6.1 Regulation Metadata

Each regulation contains:

- ID.
- Title.
- Issuing authority.
- Jurisdiction.
- Official reference number.
- Publication date.
- Effective date.
- Superseded date, if applicable.
- Current validity status.
- Source URL.
- Source retrieval date.
- Language.
- Version.
- Content hash.
- Review status.

Only verified metadata may be treated as authoritative.

## 6.2 Regulatory Obligations

A regulation can contain multiple obligations.

Each obligation should be represented independently.

Required fields:

- Obligation ID.
- Regulation ID.
- Regulation version ID.
- Article, section, or paragraph reference.
- Original legal text.
- Plain-language interpretation.
- Obligation category.
- Applicable entity types.
- Applicable business activities.
- Effective date.
- Conditional applicability.
- Required action.
- Evidence source location.
- Extraction verification status.

## 6.3 Obligation Extraction

The extraction engine must distinguish between:

- Mandatory requirements.
- Prohibitions.
- Permissions.
- Exceptions.
- Definitions.
- Explanatory provisions.
- Effective-date provisions.

An exception must not be separated from the requirement it qualifies.

When a requirement depends on another paragraph, the relationship should be preserved.

## 6.4 Historical Versions

Regulations must be evaluated against the selected assessment date.

Example:

A requirement effective on August 9, 2026, must not be treated as already effective in an assessment dated July 2026.

For the initial MVP, seed a manually verified snapshot of the selected regulatory domain. Automated monitoring may discover candidate updates, but a qualified reviewer must verify authenticity, metadata, applicability, and effective dates before a new version becomes authoritative/current.

Display:

**Regulatory corpus verified as of: [date]**

Do not market the corpus as automatically current unless the platform has actually checked and validated relevant updates.

## 6.5 Data Sources and Rights

Primary sources:

- Central Bank of Uzbekistan: https://cbu.uz
- National legal database: https://lex.uz

The repository must contain a source register documenting:

- Source name.
- URL.
- Access date.
- Documents or provisions used.
- Usage terms or licence status.
- Method of obtaining the data.
- Any restrictions on redistribution.

Avoid publishing bulk copies of official legal databases in the repository without confirming redistribution rights.

Commercial reuse of Lex.uz material requires particular attention to its published terms.

Automated retrieval must be limited to sources whose access and reuse terms permit the intended use. Store source metadata and hashes; retain or redistribute fetched full text only when permitted.

---

# 7. Synthetic FinTech Dataset

The hackathon does not provide organization data. The team must create synthetic data for a fictional fintech business and, where useful, a fictional bank profile.

## 7.1 Dataset Composition

Create a fictional fintech organization with policy documents covering more than one regulatory domain:

**Document 1: Organization Profile**

Includes legal entity type, products, customer segments, fintech activities, departments, and organizational responsibilities.

**Document 2: Customer Identification Policy**

Includes identification procedures, digital onboarding, verification methods, and documentation standards.

**Document 3: AML Internal Control Policy**

Includes customer risk assessment, transaction monitoring responsibilities, internal controls, and escalation processes.

**Additional domain coverage:**

Include a synthetic payments operations or electronic-money policy to exercise requirements from the payments and payment-systems domain. AML/KYC remains one supported domain among several, not the sole regulatory scope.

**Document 4: Beneficial Ownership Policy**

Includes ownership identification, verification procedures, and required records.

**Document 5: Compliance Governance Policy**

Includes policy review procedures, control ownership, and regulatory update responsibilities.

## 7.2 Required Test Scenarios

The synthetic data must include several types of cases:

- A provision that satisfies a regulatory obligation.
- A provision that explicitly conflicts with a requirement.
- An obligation for which no corresponding policy evidence exists.
- A policy that covers only part of a requirement.
- A policy using different language but expressing the same requirement.
- A regulation that does not apply to the fictional organization type or activities.
- A requirement whose effective date is in the future.
- An ambiguous case that requires human interpretation.

## 7.3 Data Generation Procedure

1. Select genuine regulatory obligations.
2. Extract and verify their source clauses.
3. Write synthetic fintech policies covering selected obligations across the chosen domains.
4. Introduce deliberate inconsistencies.
5. Include compliant and ambiguous cases.
6. Review the cases manually.
7. Record the expected classification and evidence.
8. Create separate evaluation documents that are not used when designing prompts.

Synthetic organization documents must be clearly identified as fictional.

## 7.4 Ground Truth

Store expected results separately from application input.

The AI must never receive the evaluation answer key.

Suggested evaluation record fields:

- Test case ID.
- Regulatory obligation ID.
- Policy document ID.
- Relevant policy passage.
- Expected classification.
- Expected regulatory citation.
- Expected policy citation.
- Expected explanation.
- Reviewer notes.

The evaluation dataset should be committed to the repository with its generation methodology.

---

# 8. AI Processing Architecture

The MVP must use a multi-stage pipeline.

A single instruction that sends all documents to an LLM and asks whether the organization is compliant is not an acceptable technical design.

## 8.1 Pipeline Stages

**Stage 1: Document Ingestion**

Extracts, normalizes, validates, and indexes document content.

**Stage 2: Regulation Understanding**

Extracts atomic obligations and their metadata into structured objects.

**Stage 3: Applicability Analysis**

Evaluates whether individual obligations apply to the organization's declared activities and entity type.

**Stage 4: Evidence Retrieval**

Finds internal policy passages potentially related to each applicable obligation.

**Stage 5: Compliance Comparison**

Evaluates the obligation against retrieved evidence.

**Stage 6: Validation**

Verifies output structure, referenced passages, and source locations.

**Stage 7: Explanation Generation**

Produces a readable explanation and a proposed action.

**Stage 8: Review and Audit**

Stores the finding and enables authorized human decisions.

Each stage should have a clear input and output contract.

## 8.2 Document Retrieval

Implement document search using a retrieval index.

Minimum viable approach:

- Section-aware chunking.
- Text indexing.
- Keyword retrieval using BM25 or an equivalent full-text method.
- Retrieval of the most relevant candidate passages.
- LLM-assisted comparison of the resulting candidates.

Optional improvement:

- Multilingual semantic embeddings.
- Hybrid keyword and vector retrieval.
- Candidate reranking.

For production, embeddings must be generated inside the regulated organization's infrastructure.

The retrieval implementation must work even if the semantic embedding feature is unavailable.

## 8.3 Multilingual Support

The system should support regulatory and policy text in:

- Russian.
- Uzbek Latin.
- Uzbek Cyrillic.

The evaluation must include at least one cross-language case.

For example, a Russian regulation paired with an Uzbek policy.

Do not assume that semantic equivalence across languages is reliable without testing.

The original-language passage must always be available alongside any translation or AI-generated explanation.

## 8.4 Structured AI Output

Each comparison must produce a validated structured result.

Required fields:

| Field | Description |
|---|---|
| obligation_id | Regulatory obligation being assessed |
| applicability | Applicable, not applicable, or uncertain |
| finding_type | Classification of the evidence |
| regulation_citation | Exact source reference |
| policy_citations | Matching internal evidence references |
| explanation | Reason for the finding |
| proposed_action | Suggested review or corrective action |
| affected_department | Suggested responsible department |
| review_required | Boolean |
| limitations | Missing information or uncertainty |

Use TypeBox/JSON Schema validation for model outputs and validate them at the backend boundary.

Reject malformed model responses.

## 8.5 Finding Classification

Use the following statuses:

**SUPPORTED_IN_POLICY**

The available internal policy text appears to address the regulatory requirement.

This does not establish that the organization follows the procedure in practice.

**POTENTIAL_CONFLICT**

The internal policy contains a provision apparently inconsistent with the regulatory requirement.

**MISSING_EVIDENCE**

No sufficient corresponding policy evidence was found.

This does not establish non-compliance.

**REQUIRES_REVIEW**

The legal requirement or policy language is ambiguous, conditional, or insufficient for reliable automated interpretation.

**NOT_APPLICABLE**

The available organization profile provides explicit evidence that the obligation does not apply.

**NOT_YET_EFFECTIVE**

The obligation has a verified future effective date.

A separate review status must indicate whether the finding has been confirmed, rejected, or left unresolved by a human reviewer.

## 8.6 Evidence Validation

Every substantive finding must contain:

- Regulation ID.
- Regulation version.
- Exact cited clause.
- Policy document ID, where relevant.
- Policy version.
- Page or section reference.
- Extracted source excerpt.

The backend must verify that cited excerpts exist in the extracted source content.

If verification fails, do not display the result as a verified citation.

The system must explicitly identify unavailable evidence.

## 8.7 AI Reliability Controls

Implement:

- Strict output schemas.
- Required citations.
- Applicability checks.
- Effective-date checks.
- Validation of document and obligation IDs.
- Handling for insufficient evidence.
- Prevention of automatic approval.
- Rejection of instructions embedded inside uploaded documents.
- Clear separation of source text from system instructions.

Uploaded documents are untrusted content and must not be allowed to change the assistant's instructions or trigger arbitrary operations.

Avoid displaying a fabricated numerical confidence score as a probability of legal correctness.

A confidence measure may be introduced later if it is calibrated against labelled results.

---

# 9. Application Interface

Use a professional B2B dashboard.

## 9.1 Screen: Dashboard

Displays:

- Active regulatory documents.
- Uploaded internal policies.
- Recent assessments.
- Findings requiring review.
- Unresolved potential conflicts.
- Recently imported regulations.

All values must come from application data.

The dashboard may initially show empty states and onboarding instructions.

## 9.2 Screen: Organization Profile

Fields:

- Organization name.
- Organization type.
- Fintech and financial-services activities.
- Products.
- Departments.
- Primary language.

Users must be able to modify their profile and rerun assessments.

## 9.3 Screen: Internal Policies

A document-management view with:

- Upload action.
- Document name.
- Document type.
- Version.
- Language.
- Processing status.
- Upload date.
- View and delete actions.

Users must be able to open the extracted document text and inspect section boundaries.

## 9.4 Screen: Regulatory Library

Displays:

- Regulation title.
- Regulatory authority.
- Regulation number.
- Effective date.
- Version.
- Validity status.
- Last verified date.
- Source link.

Allow opening an individual regulation to view its extracted obligations.

## 9.5 Screen: New Assessment

Controls:

- Select organization profile.
- Select internal documents.
- Select regulatory scope.
- Set assessment date.
- Start assessment.

During processing, display real execution progress.

The backend should report stages such as document processing, retrieval, comparison, and validation.

Do not fake progress percentages.

## 9.6 Screen: Assessment Results

Main sections:

**Summary**

- Assessed obligations.
- Potential conflicts.
- Missing evidence.
- Supported requirements.
- Findings requiring review.

**Findings Table**

Columns:

- Requirement.
- Category.
- Finding classification.
- Affected policy.
- Review status.
- Details action.

**Filters**

- Regulation.
- Finding type.
- Department.
- Review status.

## 9.7 Screen: Finding Details

This is one of the most important screens.

Use a two-column evidence layout.

**Left: Regulatory Requirement**

- Regulation title.
- Requirement text.
- Source section.
- Effective date.
- Original-language text.

**Right: Internal Organization Policy**

- Policy name.
- Relevant clause.
- Document version.
- Supporting or conflicting text.

**Below: AI Analysis**

- Applicability explanation.
- Comparison explanation.
- Potential discrepancy.
- Proposed action.
- Limitations.
- Review controls.

Allow the user to open the original evidence location.

## 9.8 Screen: Regulatory Updates

Include:

- Import new regulation.
- Select previous version when available.
- Compare versions.
- View identified changes.
- Run impact assessment.

A new regulation may be analyzed without an old version, but the system must label that as impact analysis rather than verified version-difference detection.

## 9.9 Screen: Audit History

Display a chronological list of:

- Uploads.
- Assessments.
- Generated findings.
- Human decisions.
- Notes.
- Document updates.
- Reassessments.

Include timestamps and identifiers.

---

# 10. Backend API Specification

Implement a versioned REST API under `/api`.

## 10.1 Bank Management

**POST /api/organizations**

Create a fictional regulated-organization profile.

**GET /api/organizations/:id**

Retrieve the organization profile.

**PATCH /api/organizations/:id**

Update supported profile fields.

## 10.2 Document Management

**POST /api/documents**

Upload an internal policy or regulatory document.

Request: multipart form data.

Fields:

- file.
- organization_id, when applicable.
- document_type.
- declared_language, optional.

Response:

- document_id.
- filename.
- processing_status.
- extracted_pages.
- content_hash.

**POST /api/documents/from-url**

Fetch an allowlisted official PDF or Lex.uz `/docs/{id}` HTML page and enqueue the same background extraction pipeline. Restrict hosts and redirects, require HTTPS, enforce time and size limits, validate returned content, and store the original source URL, retrieval metadata, and content hash. Direct uploads remain capped at 5 MB; the remote-fetch limit is configurable. Preserve stable clause/element references from HTML and page references from PDFs.

**GET /api/documents/:id**

Retrieve document metadata and processing status.

**GET /api/documents/:id/sections**

Retrieve the indexed document sections and references.

**DELETE /api/documents/:id**

Delete an authorized document and its associated stored content, subject to audit retention policy.

## 10.3 Regulatory Library

**GET /api/regulations**

List indexed regulations.

**GET /api/regulations/:id**

Retrieve regulation metadata and versions.

**GET /api/regulations/:id/obligations**

Retrieve extracted obligations.

**POST /api/regulations/import**

Import a new regulatory document and verified metadata.

Remote official-document ingestion is available through **POST /api/documents/from-url**. It accepts an allowlisted PDF URL or a Lex.uz `/docs/{id}` page URL, records the source URL, and queues extraction. It does not itself verify that an official page is the authoritative or applicable version.

**GET /api/regulatory-sources**

List configured official sources and their last check status/time.

**POST /api/regulatory-sources/:id/check**

Trigger an authorized on-demand check for one configured source; scheduled checks are performed by the monitoring worker.

**GET /api/regulatory-updates**

List candidate updates with detection time, source, status, and review details.

**POST /api/regulatory-updates/:id/review**

Approve or reject a candidate update. Approval creates a new immutable regulation version after source and metadata validation; rejection records the decision and reason. Both actions create audit events.

## 10.4 Assessments

**POST /api/assessments**

Start a new initial compliance assessment.

Request fields:

- organization_id.
- policy_document_ids.
- regulation_ids or corpus_id.
- assessment_date.

Response:

- assessment_id.
- status.
- created_at.

**GET /api/assessments/:id**

Return:

- status.
- processing stage.
- progress data.
- assessment metadata.
- result summary.
- errors, if any.

**GET /api/assessments/:id/findings**

Retrieve the generated findings.

**GET /api/findings/:id**

Retrieve one finding with citations and explanation.

## 10.5 Human Review

**POST /api/findings/:id/review**

Request fields:

- decision.
- reviewer_identifier.
- comment.
- optional_corrected_classification.

Allowed decisions:

- CONFIRMED.
- REJECTED.
- NEEDS_EVIDENCE.

The system must record the previous and new review states.

## 10.6 Regulatory Changes

**POST /api/regulations/compare**

Inputs:

- previous_version_id.
- new_version_id.

Output:

- comparison_id.
- detected changes.
- source references.
- processing status.

**POST /api/impact-assessments**

Inputs:

- organization_id.
- new_regulation_version_id.
- optional_previous_version_id.
- policy_document_ids.

Output:

- assessment_id.
- status.

## 10.7 Audit

**GET /api/audit-events**

Return authorized audit events with filters for assessment, document, finding, and time.

---

# 11. Database Design

Recommended database: PostgreSQL.

Core tables:

## 11.1 organizations

- id.
- name.
- organization_type.
- jurisdiction.
- activities JSON.
- products JSON.
- departments JSON.
- created_at.
- updated_at.

## 11.2 documents

- id.
- organization_id nullable.
- document_type.
- filename.
- MIME type and file size.
- storage_key.
- source_type (upload or remote).
- source_url, for remote sources.
- retrieved_at, for remotely fetched content.
- language.
- declared_version.
- content_hash.
- uploaded_at.
- processing_status.
- error_message.

## 11.3 document_sections

- id.
- document_id.
- parent_section_id nullable.
- section_number.
- heading.
- content.
- page_start.
- page_end.
- source_reference (PDF page, DOCX/TXT paragraph, or official HTML element/clause identifier).
- text_start_offset.
- text_end_offset.
- section_order.

## 11.4 regulations

- id.
- title.
- issuing_authority.
- reference_number.
- jurisdiction.
- source_url.
- created_at.

## 11.5 regulation_versions

- id.
- regulation_id.
- document_id.
- version_label.
- publication_date.
- effective_date.
- end_date.
- verification_status.
- verified_at.
- content_hash.

## 11.5a regulatory_sources

- id.
- name.
- source_url.
- source_type.
- enabled.
- check_interval_minutes.
- last_checked_at.
- last_successful_check_at.
- last_status.
- last_content_hash.
- created_at.
- updated_at.

## 11.5b regulatory_source_checks

- id.
- regulatory_source_id.
- started_at.
- completed_at.
- status.
- http_status.
- etag.
- last_modified.
- content_hash.
- error_message.

## 11.5c regulatory_update_candidates

- id.
- regulatory_source_id.
- source_check_id.
- detected_at.
- source_url.
- retrieved_content_hash.
- stored_document_id nullable.
- status (PENDING_REVIEW, APPROVED, REJECTED, FAILED).
- reviewer_identifier nullable.
- review_note nullable.
- reviewed_at nullable.
- created_regulation_version_id nullable.

## 11.6 obligations

- id.
- regulation_version_id.
- source_section_id.
- clause_reference.
- original_text.
- interpreted_requirement.
- obligation_type.
- applicable_activities JSON.
- conditions JSON.
- effective_date.
- verification_status.

## 11.7 assessments

- id.
- organization_id.
- assessment_type.
- assessment_date.
- status.
- model_identifier.
- pipeline_version.
- prompt_version.
- started_at.
- completed_at.
- processing_duration_ms.
- input_tokens.
- output_tokens.
- estimated_api_cost.

## 11.8 assessment_documents

- assessment_id.
- document_id.
- content_hash_at_assessment.

## 11.9 findings

- id.
- assessment_id.
- obligation_id.
- applicability.
- finding_type.
- explanation.
- proposed_action.
- affected_department.
- limitations.
- evidence_validation_status.
- human_review_status.
- created_at.

## 11.10 finding_evidence

- id.
- finding_id.
- document_section_id.
- source_type.
- exact_excerpt.
- start_offset.
- end_offset.
- validation_status.

## 11.11 review_decisions

- id.
- finding_id.
- reviewer_identifier.
- decision.
- comment.
- previous_status.
- new_status.
- created_at.

## 11.12 audit_events

- id.
- event_type.
- entity_type.
- entity_id.
- actor_identifier.
- timestamp.
- action_payload JSON.
- related_assessment_id.
- previous_event_hash.
- event_hash.

Use foreign keys and indexing for document retrieval, assessment history, and findings.

For the MVP, audit events should be append-only at the application level.

A cryptographic hash chain is a useful additional integrity mechanism, but it must not be described as tamper-proof unless administrative and infrastructure protections are also in place.

---

# 12. Technology Stack

## 12.1 Frontend

Recommended:

- React with TypeScript (client-side application; no Next.js).
- Ant Design for UI components and design system.
- TanStack Query.
- React Hook Form.
- Zod.
- A PDF viewer with page navigation.

The frontend should be responsive and usable on laptops and mobile devices.

Desktop should be the primary design target because the evidence-comparison workflow benefits from larger screens.

## 12.2 Backend

Recommended:

- Node.js with TypeScript.
- Fastify as the HTTP server framework.
- Fastify JSON Schema validation for request/response boundaries.
- PostgreSQL, accessed with `pg` in the current ingestion module; adopt a typed ORM/migration tool when the domain schema grows.
- `pg-boss` for durable background jobs on PostgreSQL.
- `@firecrawl/pdf-inspector` for page-aware PDF extraction and scanned-page detection.
- `mammoth` for DOCX text extraction.
- `cheerio` for extracting legal text from supported Lex.uz HTML document pages.
- `@fastify/swagger` and `@fastify/swagger-ui` for OpenAPI generation and interactive API documentation.

Use a single backend service for the MVP.

Keep route handlers thin and put business logic in application services. Isolate document extraction, AI-provider calls, retrieval, and persistence behind modules so they can be tested and replaced independently.

A separate worker process consumes durable document-processing jobs. Processing status and errors are persisted and observable through the API.

For deployments with request-duration limits, run assessment processing as a job with its status persisted in the database rather than keeping the browser request open.

## 12.3 AI Integration

Use an LLM provider abstraction.

Define operations such as:

- extract_obligations.
- assess_applicability.
- compare_policy_to_obligation.
- compare_regulation_versions.
- generate_explanation.

Each operation should accept a typed input and return a validated typed output.

During the hackathon, the implementation may call a paid external model API using synthetic documents only.

The production architecture must use a model hosted within the regulated organization's infrastructure.

Do not couple the legal comparison pipeline directly to one external provider's SDK.

## 12.4 Retrieval

Minimum:

- PostgreSQL-backed passage storage.
- Full-text or BM25-style retrieval.
- Relevant passage ranking.

Optional:

- pgvector.
- Multilingual embeddings.
- Hybrid retrieval.

Choose the simplest retrieval implementation that produces measurable results on the evaluation set.

## 12.5 Development Environment

Use Docker Compose for local development.

Services:

- frontend.
- backend.
- regulatory-monitor worker (scheduled checks; may reuse the backend image/codebase as a separate process/container).
- database.

Environment variables should configure:

- Database connection.
- AI provider.
- AI model name.
- API credentials.
- Document storage directory.
- Upload limits.
- Public application URL.
- CORS configuration.

Do not commit secrets.

---

# 13. Production Deployment Architecture

The production design must work without transmitting bank-confidential information to an external AI provider.

All sensitive processing services remain inside the regulated organization's infrastructure.

## 13.1 Components Inside the Regulated Organization

- Frontend application.
- Backend API.
- Scheduled regulatory-monitor worker.
- Document-processing service.
- PostgreSQL database.
- Private file storage.
- Retrieval index.
- Embedding model, if used.
- Locally hosted LLM.
- Audit storage.
- Identity and access controls.

A local inference server could use Ollama or vLLM with a model approved for the organization's commercial deployment.

The selected model must be tested for Russian and Uzbek regulatory documents.

## 13.2 Network Policy

Organization policy documents, embeddings, model requests, and generated compliance assessments remain inside the private environment.

No sensitive document content may be sent to third-party telemetry, analytics, or error-reporting systems.

Regulatory updates can enter through:

- Approved public-source ingestion.
- A controlled document import.
- Manual upload.

The AI processing system must continue to function without internet connectivity once the required regulations and models have been installed.

## 13.3 Production Security Requirements

Required for a real pilot:

- Role-based access control.
- Encryption in transit.
- Encryption at rest.
- Document access restrictions.
- Organization data separation.
- Encrypted backups.
- Model and dependency version management.
- Audit retention policies.
- Secure secret management.
- Restricted outbound network access.
- Controlled document deletion.
- Malware and unsafe-file screening.
- Infrastructure logging.

The hackathon prototype does not need to implement all enterprise infrastructure, but the architecture must clearly describe it.

## 13.4 Accuracy Limitation

Switching to a local model does not guarantee equivalent performance to the externally hosted model used during the hackathon.

A production pilot must separately benchmark the chosen local model and adjust the deployment based on measured accuracy, latency, and hardware requirements.

---

# 14. Public Demo Deployment

The hackathon requires a publicly accessible working application.

Recommended deployment:

- Frontend: Vercel.
- Backend: Railway or Render.
- Database: managed PostgreSQL.
- Repository: GitHub.

Deploy both frontend and backend from the submitted repository.

## 14.1 Demo Data Protection

The public application must use synthetic financial-organization information only.

Required safeguards:

- A visible synthetic-data-only notice.
- Isolated demo sessions.
- File type and size validation.
- Basic request rate limiting.
- Backend-controlled AI credentials.
- No public document-directory listing.
- Ability to reset the fictional workspace.

Do not invite visitors to upload actual confidential bank documents.

Anonymous demo sessions should not share each other's private uploads or assessment histories.

## 14.2 Demo Reset

Provide a reset operation that clears the current session's synthetic documents and findings.

The application should be usable repeatedly by judges.

## 14.3 Deployment Verification

Before submission:

- Test the application from a different device.
- Test the full frontend-to-backend workflow.
- Confirm database persistence.
- Verify that AI requests work in the deployed environment.
- Test one completely new uploaded document.
- Confirm that the submitted Git commit matches the deployed application.
- Record a complete backup demonstration.
- Verify scheduled source checks, failure visibility, candidate review, and that approved updates create new versions without altering prior assessments.

---

# 15. Explainability and Auditing

Every generated finding must have a transparent evidence trail.

## 15.1 Explanation Requirements

For each finding, show:

1. What the regulation requires.
2. Why the obligation appears applicable.
3. Which internal policy passages were considered.
4. What those passages establish.
5. What discrepancy or uncertainty was identified.
6. What action the system recommends.
7. What information is still missing.

Use source excerpts rather than unsupported explanations.

## 15.2 Audit Requirements

Store:

- Assessment ID.
- Timestamp.
- Assessment date.
- Input document identifiers.
- Input content hashes.
- Regulatory corpus version.
- AI model identifier.
- Prompt version.
- Pipeline version.
- Generated classification.
- Supporting evidence IDs.
- Validation status.
- Human decisions.
- Review notes.

Model outputs should be retained as assessment records so that the result does not silently change when a model or prompt is updated.

## 15.3 Human-in-the-Loop Workflow

The AI generates a draft finding.

A compliance officer reviews the finding and its evidence.

The officer may confirm, reject, or request more information.

A confirmed finding may become a remediation task.

The system must not:

- Automatically modify organization policies.
- Automatically mark the organization legally compliant.
- Submit regulatory reports.
- Automatically close findings without review.
- Replace the compliance officer's responsibility.

---

# 16. Evaluation and Quality Measurement

This section is especially important because the technology criteria account for half of the hackathon score.

## 16.1 Test Dataset

Create a manually labelled evaluation dataset with a target of at least 30 to 40 obligation-policy test pairs.

Distribute evaluation cases across the selected MVP fintech domains and relevant organization types; do not let AML/KYC dominate the test set merely because it is familiar.

Include:

- Explicit compliance-support cases.
- Explicit contradictions.
- Missing evidence.
- Partial coverage.
- Ambiguous wording.
- Cross-language passages.
- Non-applicable requirements.
- Effective-date edge cases.
- Unrelated or adversarial documents.

Reserve a portion of the cases as a held-out evaluation set.

Do not tune the system against the held-out answer key.

## 16.2 Metrics

Measure:

**Finding classification accuracy**

The proportion of evaluated cases assigned the correct classification.

**Potential-conflict precision**

Of the items flagged as conflicts, how many are true conflicts according to the evaluation labels?

**Potential-conflict recall**

Of the known conflicts, how many did the system identify?

**Citation validity**

Percentage of cited excerpts that correctly resolve to their stated source locations.

**Evidence retrieval recall**

Percentage of cases where the relevant policy evidence appears among the retrieved candidates.

**Abstention quality**

Whether the system identifies cases with insufficient evidence rather than inventing conclusions.

**Processing time**

- Total assessment duration.
- Time per obligation.
- Median processing time.
- 95th-percentile processing time when enough samples are available.

**AI cost**

- Input tokens.
- Output tokens.
- Cost per assessment.
- Cost per assessed obligation.

## 16.3 Evaluation Report

Generate a report containing:

- Dataset size.
- Language distribution.
- Class distribution.
- Confusion matrix.
- Classification metrics.
- Citation validity.
- Processing-time statistics.
- API cost statistics.
- Representative correct examples.
- Representative incorrect examples.
- Known failure cases.

Metrics must be calculated by code from actual test results.

Do not manually enter invented model accuracy or latency figures.

## 16.4 Quality Gates

Suggested internal acceptance targets:

- All generated source references must resolve to stored documents or be explicitly marked unverified.
- Zero automatic final compliance approvals.
- No leakage of one demo session's documents into another session.
- Successful processing of at least one previously unseen document.
- At least one human-review decision recorded and retrievable.
- Evaluation results reproducible from repository scripts.

An aspirational target is 85% or higher precision for explicit conflict findings and 95% or higher citation validity, but these are development targets, not claims of achieved performance.

Report actual measurements even if results fall below the targets.

---

# 17. Business Model

## 17.1 Target Customers

Primary customers:

- Commercial banks.
- Payment organizations and payment-system operators.
- Electronic-money providers.
- Other regulated fintech and financial-service businesses in Uzbekistan.

The MVP is designed for compliance, legal, risk, and regulatory-affairs teams across these organization types.

## 17.2 Buyer and User

**Economic buyer:** Head of Compliance, Chief Risk Officer, or another executive responsible for compliance technology budgets.

**Daily user:** Compliance officer or regulatory specialist.

**Technical approver:** Information Security and IT Infrastructure teams.

## 17.3 Revenue Model

Recommended commercial model:

- Annual enterprise software licence.
- One-time onboarding and integration fee.
- Optional charges for advanced modules or additional regulatory domains.

For banks requiring private deployments, licensing and technical support should be structured around bank-controlled infrastructure.

## 17.4 Measurable Value

The MVP should focus on measurable labor savings rather than claiming that it prevents all regulatory fines.

Potential metrics:

- Time to review one regulatory obligation.
- Time to prepare an initial policy assessment.
- Number of manual comparison steps.
- Time to identify affected internal policies.
- Time to prepare an audit-ready report.
- Number of missed or unsupported findings in evaluation.

## 17.5 ROI Formula

Monthly labor savings:

**Assessments per month × hours saved per assessment × fully loaded staff cost per hour**

Monthly net benefit:

**Monthly labor savings minus monthly operating cost**

Estimated payback period:

**Initial implementation cost divided by monthly net benefit**

Calculate payback only when monthly net benefit is positive.

## 17.6 Illustrative Business Scenario

The following figures are hypothetical assumptions, not verified Uzbekistan bank operating statistics.

| Input | Assumption |
|---|---:|
| Assessments per month | 15 |
| Manual time per assessment | 2 hours |
| AI-assisted time including review | 0.5 hours |
| Hours saved monthly | 22.5 |
| Loaded staff cost per hour | 150,000 UZS |
| Monthly labor savings | 3,375,000 UZS |
| Monthly operating cost | 1,000,000 UZS |
| Monthly net benefit | 2,375,000 UZS |
| Initial implementation cost | 20,000,000 UZS |
| Illustrative payback | Approximately 8.4 months |

These numbers are examples for demonstrating the financial model.

The final pitch should distinguish between:

- Verified external facts.
- Measured prototype performance.
- Customer interview findings.
- Hypothetical financial assumptions.

## 17.7 Pilot Cost Model

Estimate a three-month pilot covering:

- Engineering labor.
- Compliance specialist review time.
- Local inference hardware or server rental.
- Database and storage.
- Deployment and integration.
- Security review.
- Maintenance.
- Regulatory data access or licensing.
- Evaluation and retraining of prompts or models.

Do not exclude personnel costs merely because hackathon development used student labor.

## 17.8 Three-Month Pilot Plan

**Month 1:**

- Confirm a specific regulatory domain.
- Obtain approved internal documents.
- Deploy inside the regulated organization.
- Establish a reviewed regulatory baseline.

**Month 2:**

- Run supervised assessments.
- Compare results with the organization's existing manual process.
- Measure quality, review time, and false positives.

**Month 3:**

- Refine retrieval and comparison.
- Evaluate the on-premises model.
- Measure cost savings.
- Prepare a decision on further adoption.

---

# 18. Innovation and Defensibility

The product is inspired by the broader category of regulatory intelligence and compliance automation software.

The underlying category is not globally new.

The product should therefore demonstrate innovation through technical execution and localization.

## 18.1 Technical Differentiators

**1. Uzbekistan-specific regulatory knowledge**

Structured obligations, effective dates, authority references, and version histories.

**2. Multilingual regulatory comparison**

Matching Russian regulatory requirements against Uzbek or Russian internal policy documents.

**3. Evidence-backed policy mapping**

Linking each obligation to the relevant internal policy clause rather than producing an unsupported summary.

**4. Temporal regulatory analysis**

Distinguishing regulations currently in effect from historical versions and future requirements.

**5. Explainable human review**

Every proposed gap has an evidence trail, review status, and accountable reviewer.

**6. Private deployment capability**

An architecture designed to operate without external AI services.

## 18.2 Defensibility Limitations

A small initial regulatory corpus and generic LLM prompts are relatively easy for competitors to replicate.

Stronger long-term advantages would require:

- A larger verified regulatory knowledge base.
- Better multilingual evaluation datasets.
- Domain-specific obligation extraction.
- Validated bank-policy mappings.
- Integrations with real compliance workflows.
- Measured reliability and low false-positive rates.

Do not claim that these long-term advantages already exist after a 23-hour build.

The hackathon should demonstrate credible early evidence of those advantages.

---

# 19. Development Plan: 23 Hours

## Hours 0–2: Scope and Data

Tasks:

- Select a manageable initial set of fintech regulatory domains and official sources.
- Select real official regulatory clauses.
- Verify effective dates.
- Prepare the fictional fintech organization profile.
- Generate initial synthetic policies.
- Design the evaluation labels.

Deliverables:

- Source register.
- Initial regulations.
- Synthetic documents.
- Defined API/data contracts.

## Hours 2–5: Foundation and Ingestion

Tasks:

- Initialize repository.
- Configure frontend and backend.
- Configure database.
- Implement document upload.
- Implement PDF/DOCX/TXT extraction and allowlisted remote PDF/Lex.uz HTML ingestion.
- Run ingestion asynchronously with persisted job and document statuses.
- Publish API schemas through Swagger/OpenAPI.
- Store structured document sections.

Deliverable:

A working document-ingestion flow.

## Hours 5–9: AI Assessment Pipeline

Tasks:

- Build obligation extraction.
- Implement retrieval.
- Implement applicability analysis.
- Implement policy comparison.
- Add structured output validation.
- Validate source citations.

Deliverable:

An end-to-end backend assessment returning real findings.

## Hours 9–13: Application Interface

Tasks:

- Build dashboard.
- Build document-management screen.
- Build assessment creation.
- Build results table.
- Build side-by-side finding details.

Deliverable:

A functional user interface connected to the backend.

## Hours 13–16: Regulatory Impact and Audit

Tasks:

- Add new regulation import.
- Implement limited version or change analysis.
- Add finding review actions.
- Add persistent audit history.
- Implement narrow monitoring for one or two permitted official sources, with scheduled checks, change detection, pending-update review, and version creation on approval.

Deliverable:

Both workflows available, with human review.

If time is insufficient, prioritize a reliable monitor for one source with an explicit candidate-review workflow over broad or unreliable crawling. Manual import remains the fallback.

## Hours 16–19: Evaluation and Reliability

Tasks:

- Run the labelled test set.
- Record accuracy and retrieval metrics.
- Check citation correctness.
- Measure request time and API costs.
- Test unseen input.
- Fix critical errors.

Deliverable:

A reproducible evaluation report.

## Hours 19–21: Deployment

Tasks:

- Deploy frontend and backend.
- Configure the database.
- Test a public URL.
- Verify demo-session isolation.
- Confirm deployment from the submitted repository.
- Run the complete workflow from a separate device.

Deliverable:

Publicly reachable working prototype.

## Hours 21–23: Defence Preparation

Tasks:

- Prepare slides.
- Prepare the business model.
- Capture measured results.
- Create the architecture diagram.
- Record a backup demo.
- Complete README.
- Rehearse the seven-minute presentation.
- Freeze the repository according to the hackathon rules.

Deliverable:

Submission-ready prototype, deck, and repository.

---

# 20. Demo Data and Presentation Plan

Use a screenshot-first presentation, with a short, rehearsed live walkthrough only if time permits. Target 5–7 minutes for the product story; do not wait for imports or assessments to finish during the presentation. Keep the prepared app open as a backup, and capture readable, cropped screenshots from the actual product.

## 20.1 Regulatory Sources and Version Setup

The candidate Lex.uz documents are:

- Payments and Payment Systems: https://lex.uz/docs/4575788
- https://lex.uz/docs/4396428
- https://lex.uz/docs/5960609
- https://lex.uz/docs/6213428
- https://lex.uz/docs/5972413

Before importing, inspect each source's available versions, revision dates, and relevant changes. Select a clear, policy-related update for one or two documents. For most sources, use the latest version. For selected source(s), import a suitable historical version as the organization's initial demo baseline, then import the latest version into the same regulation's version group.

Label the older snapshot accurately as the organization's **demo baseline before the update**, not as current law. Verify dates and legal applicability from the official source. Do not claim that monitoring automatically detected an update if it was manually imported for the demonstration.

## 20.2 Fictional Company Policy Pack

Create a fictional fintech/bank profile whose activities fit the applicable requirements in the five selected sources. Draft a small, coherent set of clearly labelled fictional internal policies (for example, customer identification, payments, and complaints/customer treatment), rather than one artificial policy per regulation.

Only after reviewing the actual source clauses, introduce a few controlled, realistic gaps: approximately 2–3 explicit conflicts against the initial baseline, 1–2 missing procedures/evidence gaps, several compliant provisions, and—if the chosen revision supports it—one provision compliant with the old baseline but inconsistent with the newer text. Never invent a legal obligation to manufacture a finding.

Maintain a private expected-results checklist mapping each intended issue to the official clause, exact policy passage, and expected classification. Run the assessment before the demo and verify the evidence and classifications. Fix or remove planted issues that produce unsupported or confusing findings. Clearly mark all policy files as fictional demonstration material.

## 20.3 Presentation Story

1. **Baseline:** show the manually curated regulations and their selected snapshot/revision dates; explain that the organization controls its assessment corpus.
2. **Initial policy check:** show the fictional internal policy and a completed assessment. Open one strong evidence-backed finding with the regulatory clause and policy passage side by side.
3. **Regulatory update:** show the before/after source text and reviewed new version, then the incremental assessment with new, changed, and unchanged findings. Explain that internal policies are not automatically rewritten.
4. **Notification:** show the actual delivered email and how it takes the reviewer to the relevant assessment.
5. **Separate new-act triage:** show a short amending act in the legislation inbox, human relevance review, and its separate preliminary impact assessment. Emphasize that discovery/relevance does not silently add the act to the regulatory baseline.

## 20.4 Screenshot Checklist

- Regulatory library with source names and meaningful version/revision labels.
- Initial completed assessment with clear finding counts/classifications.
- One finding detail with source-backed regulatory and policy passages.
- Official before/after amendment comparison and reviewed version.
- Updated impact assessment showing changed findings.
- Delivered notification email.
- Separate legislation inbox row, human review decision, and direct assessment link.

Use large, legible screenshots; avoid showing AI usage statistics or cost figures. If anything is staged, say so. Close by stating that RegCheck supports human compliance decisions and does not certify legal compliance.

---

# 21. Seven-Minute Defence Structure

## Slide 1: Product and Problem — 45 seconds

Include:

- Product name.
- Startup mode.
- Target user.
- Problem statement.
- One-sentence value proposition.

## Slide 2: Evidence and Opportunity — 45 seconds

Include:

- Real regulatory compliance problem.
- Target customer.
- Verified Uzbekistan-specific context.
- Clearly distinguished assumptions.

## Slide 3: Live Product Demo — 2 minutes

Demonstrate initial assessment and regulatory change impact.

## Slide 4: Technical Architecture — 1 minute

Explain:

- Document ingestion.
- Regulatory knowledge base.
- Retrieval.
- Structured AI analysis.
- Evidence validation.
- Human approval.
- Audit history.

## Slide 5: Evaluation and Innovation — 1 minute

Present:

- Real measured evaluation results.
- Latency.
- API cost.
- Known failure cases.
- Technical differentiators.

## Slide 6: Business Model and ROI — 1 minute

Include:

- Buyer.
- Pricing approach.
- Pilot cost.
- Expected benefits.
- Payback assumptions.

## Slide 7: Pilot Plan and Closing — 30 seconds

Show:

- Three-month pilot plan.
- On-premises architecture.
- Next development priorities.

Total: seven minutes.

---

# 22. Repository Specification

Suggested repository structure:

regcheck-uz/

- apps/
  - web/
  - api/
    - src/
      - routes/
      - db/
      - schemas/
      - lib/
      - services/
      - ai/
      - retrieval/
      - ingestion/
      - evaluation/
      - audit/
- data/
  - synthetic/
  - regulatory-metadata/
  - evaluation/
- scripts/
  - generate-synthetic-data
  - seed-regulatory-corpus
  - run-evaluation
- docs/
  - architecture.md
  - data-sources.md
  - evaluation.md
  - security.md
  - business-model.md
- deploy/
  - docker-compose.yml
- README.md
- LICENSE, for original team code
- .env.example

## 22.1 README Requirements

The README must document:

1. Product description.
2. Hackathon mode and track.
3. Main features.
4. Architecture.
5. Technology stack.
6. Local installation.
7. Environment variables.
8. Database initialization.
9. Synthetic data generation.
10. Regulatory data sources and licences.
11. AI models and external services.
12. How to run evaluation.
13. How to reproduce the demo.
14. Public deployment URL.
15. Production security architecture.
16. Known limitations.
17. Attribution for external tools, code, models, and ideas.

All source code submitted as hackathon work must satisfy the competition's work-origin and attribution rules.

---

# 23. Acceptance Criteria

The MVP must pass these checks.

## Functional

- [ ] User can create a fictional regulated-organization profile.
- [ ] User can upload an original PDF, DOCX, or text policy.
- [ ] Uploaded text is actually extracted and stored.
- [ ] User can inspect the indexed regulatory corpus.
- [ ] User can start an initial compliance assessment.
- [ ] AI retrieves relevant internal policy evidence.
- [ ] AI generates structured classifications.
- [ ] Findings contain source-backed explanations.
- [ ] User can review and reject or confirm findings.
- [ ] Human review actions persist in the database.
- [ ] User can upload a new regulatory document.
- [ ] User can ingest a supported official Lex.uz `/docs/{id}` page URL without relying on OCR.
- [ ] Extracted official-page sections retain stable element references, source URL, retrieval time, and content hash.
- [ ] OpenAPI/Swagger documentation describes the available API routes and payloads.
- [ ] Scheduled monitoring checks at least one configured official source and records check status.
- [ ] Detected changes appear as pending candidates and require human review before becoming current.
- [ ] Approving an update creates a new immutable version; prior versions and assessment references remain unchanged.
- [ ] The system can perform a new regulation impact assessment.
- [ ] Previously saved assessments are retrievable.

## Technical

- [ ] Model responses are schema validated.
- [ ] Source references are verified against document content.
- [ ] Missing evidence is distinguished from a violation.
- [ ] Effective dates are considered.
- [ ] API failures are handled visibly.
- [ ] No assessment uses hardcoded final answers.
- [ ] Evaluation metrics are calculated programmatically.
- [ ] Input, output, and processing costs are recorded.
- [ ] Model and pipeline versions are recorded.

## Security

- [ ] No real confidential banking data is used.
- [ ] API credentials are stored server-side.
- [ ] Demo workspaces are isolated.
- [ ] File uploads are validated.
- [ ] Production on-premises deployment is documented.

## Hackathon

- [ ] Frontend and backend are publicly accessible.
- [ ] Deployment corresponds to the submitted repository.
- [ ] Unseen input can be processed.
- [ ] Dataset generation is documented.
- [ ] Data sources and licences are documented.
- [ ] Presentation fits seven minutes.
- [ ] Cost model uses declared assumptions.
- [ ] Limitations and failure cases are disclosed.
- [ ] A recorded backup demo exists.

---

# 24. Explicitly Out of Scope

The 23-hour MVP will not attempt to provide:

- Guaranteed legal compliance certification.
- Real-time integration with bank core systems.
- Transaction-level AML monitoring.
- Automatic regulatory reporting to government authorities.
- Autonomous modification of internal bank procedures.
- Coverage of every Uzbek financial-sector or fintech regulation.
- Fully automated legal interpretation.
- Enterprise-wide workflow integration.
- Production-ready user provisioning and SSO.
- Guaranteed processing of scanned PDFs.
- Comprehensive monitoring of every Uzbek regulatory website; MVP monitoring is limited to a small allowlist and requires human verification.
- Complete historical legal reconstruction.

These features may be added in later development phases.

---

# 25. Risk Register

| Risk | Mitigation |
|---|---|
| AI generates incorrect legal interpretations | Source citations, validation, human review |
| Missing or incorrect legal effective dates | Verified metadata and explicit unknown status |
| AI invents policy evidence | Validate exact cited text |
| Incorrect matching across languages | Test multilingual cases and permit abstention |
| Missing policy treated as proven violation | Use MISSING_EVIDENCE classification |
| Long document processing delays | Restrict file size and page counts |
| External LLM downtime | Error handling and retry controls |
| Local model differs in accuracy | Separate production model benchmarking |
| Data source licensing restrictions | Source register and permission review |
| Broad fintech regulatory coverage is difficult to validate | Start with a curated multi-domain corpus and disclose entity, domain, and version coverage |
| Weak hackathon differentiation | Measured evaluation, structured pipeline, domain-specific corpus |
| Public demo exposes uploaded documents | Session isolation and synthetic-only restriction |

---

# 26. Final Product Definition

**RegCheck UZ is an AI-assisted fintech regulatory compliance platform that compares internal policies against applicable financial-sector regulations, identifies evidence-backed potential gaps, analyzes regulatory changes, and supports auditable human review.**

The MVP must prove five capabilities:

1. **Understanding:** Extract specific requirements from real financial-sector and fintech regulations.
2. **Comparison:** Find and compare relevant internal policy provisions.
3. **Explanation:** Provide traceable evidence for every substantive finding.
4. **Accountability:** Keep compliance officers responsible for final decisions and preserve an audit trail.
5. **Measurable value:** Demonstrate quality, processing time, operating cost, and a credible financial case.

The central technical objective is to build a reliable **regulation-to-policy comparison pipeline**, supported by a versioned regulatory knowledge base, evidence retrieval, structured analysis, and human review.

The initial compliance assessment is the primary MVP feature. Regulatory change impact analysis extends the same infrastructure and demonstrates how the platform can continue serving regulated fintech organizations after onboarding.
