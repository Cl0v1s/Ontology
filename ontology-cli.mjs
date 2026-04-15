#!/usr/bin/env node
/**
 * ontology-cli.mjs — CLI for managing the JSON-LD knowledge ontology
 *
 * COMMANDS
 *   add-article       Read a JSON payload from stdin, create article + concepts
 *   find  <keyword>   Search concepts/articles by keyword
 *   validate          Check the ontology for structural errors
 *   promote <id> <theme-file>   Move a concept from an article file to a theme file
 *   fix                         Auto-promote all concepts linked to a theme concept
 *
 * WORKFLOW FOR THE AGENT
 *   1. Run `find` to check whether the concepts you identified already exist.
 *   2. Build the JSON payload (schema below) for `add-article`.
 *   3. Pipe it: echo '<json>' | node ontology-cli.mjs add-article
 *   4. Read the JSON result on stdout to see what was created / skipped / warned.
 *   5. When two articles share a concept, run `promote` to move it to a theme file.
 *   5b. Run `fix` to auto-promote all concepts linked to an existing theme concept.
 *   6. Run `validate` before every commit.
 *
 * INPUT SCHEMA FOR add-article
 * ─────────────────────────────
 * {
 *   "article": {
 *     "@id":          "ko:article/<slug>",          // required
 *     "title":        "...",                         // required
 *     "url":          "https://...",                 // required
 *     "readDate":     "YYYY-MM-DD",                  // required
 *     "publishedDate":"YYYY-MM-DD",                  // optional
 *     "language":     "en",                          // optional, default "en"
 *     "abstract":     "...",                         // optional
 *     "hasAuthor":    "ko:author/<slug>",            // optional
 *     "introduces":   ["ko:concept/..."],            // optional
 *     "uses":         ["ko:concept/..."],            // optional
 *     "critiques":    ["ko:concept/..."],            // optional
 *     "exemplifies":  ["ko:concept/..."],            // optional
 *     "hasFeature":   ["ko:concept/..."],            // optional
 *     "usesLanguage": ["ko:concept/..."]             // optional
 *   },
 *   "newConcepts": [                                 // only concepts not yet in ontology
 *     {
 *       "@id":        "ko:concept/<slug>",           // required
 *       "prefLabel":  "Official Name",               // required
 *       "definition": "...",                         // required
 *       "domain":     "software engineering",        // required — used to pick theme file
 *       "altLabel":   ["synonym"],                   // optional
 *       "broader":    "ko:concept/<parent>",         // optional
 *       "narrower":   ["ko:concept/<child>"],        // optional
 *       "related":    ["ko:concept/<peer>"]          // optional
 *     }
 *   ],
 *   "newAuthors": [                                  // only authors not yet in shared.jsonld
 *     {
 *       "@id":  "ko:author/<slug>",                  // required
 *       "name": "Full Name"                          // required
 *     }
 *   ]
 * }
 *
 * PLACEMENT RULES (enforced by this script, not the agent)
 * ─────────────────────────────────────────────────────────
 * Authors       → always shared.jsonld
 * New concepts  → article file  (by default)
 *                 theme file    (if --promote flag, or if concept.domain matches an
 *                                existing theme and concept is already referenced by
 *                                another article)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── JSON-LD @context (canonical) ───────────────────────────────────────────────

const CONTEXT = {
  owl:     'http://www.w3.org/2002/07/owl#',
  rdf:     'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs:    'http://www.w3.org/2000/01/rdf-schema#',
  skos:    'http://www.w3.org/2004/02/skos/core#',
  dc:      'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  xsd:     'http://www.w3.org/2001/XMLSchema#',
  ko:      'http://knowledge.local/ontology#',
};

// ── File I/O ────────────────────────────────────────────────────────────────────

function* allJsonldFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* allJsonldFiles(full);
    else if (entry.name.endsWith('.jsonld')) yield full;
  }
}

function readJsonld(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fatal(`Invalid JSON in ${relPath(path)}: ${e.message}`);
  }
}

function writeJsonld(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function relPath(p) {
  return p.replace(__dir + '/', '');
}

// ── Index ───────────────────────────────────────────────────────────────────────
// Maps ko:id → { item, file }
// When duplicates exist (article + theme), keeps BOTH under a "locations" array.

function buildIndex() {
  const index = new Map(); // id → { item, file, locations: [{item, file}] }

  for (const file of allJsonldFiles(__dir)) {
    const data = readJsonld(file);
    for (const item of data['@graph'] ?? []) {
      const id = item['@id'];
      if (!id?.startsWith('ko:')) continue;

      if (index.has(id)) {
        // Keep track of all locations for duplicate detection
        index.get(id).locations.push({ item, file });
      } else {
        index.set(id, { item, file, locations: [{ item, file }] });
      }
    }
  }
  return index;
}

// ── Domain → theme file mapping ─────────────────────────────────────────────────

function buildDomainMap() {
  // Maps normalised domain string → theme file path
  const map = new Map();
  const themesDir = join(__dir, 'themes');

  if (!existsSync(themesDir)) return map;

  for (const entry of readdirSync(themesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonld')) continue;
    const slug = entry.name.replace('.jsonld', ''); // e.g. "software-engineering"
    const domain = slug.replace(/-/g, ' ');         // e.g. "software engineering"
    map.set(domain.toLowerCase(), join(themesDir, entry.name));
    map.set(slug.toLowerCase(), join(themesDir, entry.name));
  }
  return map;
}

function resolveThemeFile(domain) {
  const domainMap = buildDomainMap();
  const key = domain.toLowerCase().trim();

  // Exact match
  if (domainMap.has(key)) return domainMap.get(key);

  // Partial match (domain contains the theme name or vice-versa)
  for (const [k, v] of domainMap) {
    if (key.includes(k) || k.includes(key)) return v;
  }

  return null; // No matching theme — will go to article file
}

// ── Validation helpers ──────────────────────────────────────────────────────────

const ARTICLE_RELATION_KEYS = ['introduces', 'uses', 'critiques', 'exemplifies', 'hasFeature', 'usesLanguage'];
const CONCEPT_ALLOWED_KEYS   = new Set(['@id', '@type', 'prefLabel', 'altLabel', 'definition', 'domain', 'broader', 'narrower', 'related']);
const ARTICLE_ALLOWED_KEYS   = new Set(['@id', '@type', 'title', 'url', 'publishedDate', 'readDate', 'language', 'abstract', 'hasAuthor', ...ARTICLE_RELATION_KEYS]);

function validateArticlePayload(article) {
  const errors = [];
  if (!article['@id']?.startsWith('ko:article/'))     errors.push('@id must start with ko:article/');
  if (!article.title)                                  errors.push('title is required');
  if (!article.url)                                    errors.push('url is required');
  if (!article.readDate?.match(/^\d{4}-\d{2}-\d{2}$/)) errors.push('readDate must be YYYY-MM-DD');

  for (const key of Object.keys(article)) {
    if (!ARTICLE_ALLOWED_KEYS.has(key)) errors.push(`Unknown article property "${key}"`);
  }

  for (const rel of ARTICLE_RELATION_KEYS) {
    const refs = [article[rel] ?? []].flat();
    for (const r of refs) {
      if (!r.startsWith('ko:')) errors.push(`${rel}: "${r}" does not start with ko:`);
    }
  }
  return errors;
}

function validateConceptPayload(concept) {
  const errors = [];
  if (!concept['@id']?.startsWith('ko:concept/')) errors.push('@id must start with ko:concept/');
  if (!concept.prefLabel)                          errors.push('prefLabel is required');
  if (!concept.definition)                         errors.push('definition is required');
  if (!concept.domain)                             errors.push('domain is required');

  for (const key of Object.keys(concept)) {
    if (!CONCEPT_ALLOWED_KEYS.has(key)) errors.push(`Unknown concept property "${key}"`);
  }
  return errors;
}

function validateAuthorPayload(author) {
  const errors = [];
  if (!author['@id']?.startsWith('ko:author/')) errors.push('@id must start with ko:author/');
  if (!author.name)                              errors.push('name is required');
  return errors;
}

function slugCheck(id, prefLabel) {
  const raw = (id.split('/').at(-1) ?? '').toLowerCase();
  const expected = prefLabel.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (raw !== expected) {
    return `slug "${raw}" differs from prefLabel-derived slug "${expected}"`;
  }
  return null;
}

function stripEmpty(obj) {
  // Remove keys with null/undefined/empty-array values
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) =>
      v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)
    )
  );
}

function cleanConcept(c) {
  return stripEmpty({
    '@id':       c['@id'],
    '@type':     'ko:Concept',
    prefLabel:   c.prefLabel,
    altLabel:    c.altLabel?.length ? c.altLabel : undefined,
    definition:  c.definition,
    domain:      c.domain,
    broader:     c.broader  ?? undefined,
    narrower:    c.narrower?.length ? c.narrower : undefined,
    related:     c.related?.length  ? c.related  : undefined,
  });
}

function cleanArticle(a) {
  const obj = { '@id': a['@id'], '@type': 'ko:Article' };
  for (const key of [...ARTICLE_ALLOWED_KEYS].filter(k => k !== '@id' && k !== '@type')) {
    if (a[key] !== undefined && a[key] !== null) {
      const v = a[key];
      if (!Array.isArray(v) || v.length > 0) obj[key] = v;
    }
  }
  return obj;
}

// ── Output helpers ──────────────────────────────────────────────────────────────

function fatal(msg) {
  console.error(`\nFATAL: ${msg}\n`);
  process.exit(1);
}

function out(result) {
  console.log(JSON.stringify(result, null, 2));
}

// ── COMMAND: add-article ────────────────────────────────────────────────────────

async function cmdAddArticle(args) {
  // Read stdin
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) fatal('No input received on stdin. Pipe a JSON payload.');

  let payload;
  try { payload = JSON.parse(raw); }
  catch (e) { fatal(`Invalid JSON input: ${e.message}`); }

  const { article, newConcepts = [], newAuthors = [] } = payload;
  if (!article) fatal('"article" field is required in the payload.');

  // ── Validate input ──
  const articleErrors = validateArticlePayload(article);
  if (articleErrors.length) fatal(`Article validation:\n  • ${articleErrors.join('\n  • ')}`);

  for (const c of newConcepts) {
    const errs = validateConceptPayload(c);
    if (errs.length) fatal(`Concept ${c['@id'] ?? '(no @id)'} validation:\n  • ${errs.join('\n  • ')}`);
  }
  for (const a of newAuthors) {
    const errs = validateAuthorPayload(a);
    if (errs.length) fatal(`Author ${a['@id'] ?? '(no @id)'} validation:\n  • ${errs.join('\n  • ')}`);
  }

  // ── Build index ──
  const index = buildIndex();

  const result = {
    ok:       true,
    created:  [],  // { '@id', '@type', file }
    skipped:  [],  // { '@id', reason, file }
    warnings: [],
    files:    {},  // file → 'created' | 'updated'
  };

  const warn = msg => result.warnings.push(msg);

  // ── Check article uniqueness ──
  if (index.has(article['@id'])) {
    fatal(`Article ${article['@id']} already exists in ${relPath(index.get(article['@id']).file)}`);
  }
  for (const [id, entry] of index) {
    if (entry.item['@type'] === 'ko:Article' && entry.item.url === article.url) {
      warn(`URL already used by ${id} — double-check this isn't a duplicate article`);
    }
  }

  // ── Process authors → shared.jsonld ──
  const sharedPath = join(__dir, 'shared.jsonld');
  const sharedData = readJsonld(sharedPath);
  let sharedModified = false;

  for (const author of newAuthors) {
    if (index.has(author['@id'])) {
      result.skipped.push({ '@id': author['@id'], reason: 'already defined', file: relPath(index.get(author['@id']).file) });
      continue;
    }
    const node = { '@id': author['@id'], '@type': 'ko:Author', name: author.name, domain: 'author' };
    sharedData['@graph'].push(node);
    index.set(author['@id'], { item: node, file: sharedPath, locations: [{ item: node, file: sharedPath }] });
    result.created.push({ '@id': author['@id'], '@type': 'ko:Author', file: 'shared.jsonld' });
    sharedModified = true;
  }

  // ── Auto-create missing authors referenced in hasAuthor ──
  for (const a of [article.hasAuthor ?? []].flat()) {
    if (!index.has(a)) {
      const slug = a.replace('ko:author/', '');
      const name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const node = { '@id': a, '@type': 'ko:Author', name, domain: 'author' };
      sharedData['@graph'].push(node);
      index.set(a, { item: node, file: sharedPath, locations: [{ item: node, file: sharedPath }] });
      result.created.push({ '@id': a, '@type': 'ko:Author', file: 'shared.jsonld', note: `auto-created from slug` });
      sharedModified = true;
    }
  }

  // ── Process concepts ──
  // Separate into: (a) skip existing, (b) new → article file, (c) new → theme file
  const conceptsForArticle = [];
  const conceptsForTheme   = new Map(); // themeFilePath → [concept nodes]

  for (const concept of newConcepts) {
    const id = concept['@id'];

    if (index.has(id)) {
      const existing = index.get(id);
      result.skipped.push({ '@id': id, reason: 'already defined', file: relPath(existing.file) });
      continue;
    }

    // Slug hint
    const slugHint = slugCheck(id, concept.prefLabel);
    if (slugHint) warn(`Concept ${id}: ${slugHint}`);

    const node = cleanConcept(concept);

    // Placement: try to match domain to a theme file
    const themeFile = resolveThemeFile(concept.domain);
    if (themeFile) {
      // Only send to theme file if concept was explicitly meant to be thematic
      // (domain matched a theme). New single-article concepts still go to article file
      // unless the agent explicitly uses --promote.
      // Default: article file. Agent can promote later.
      conceptsForArticle.push(node);
    } else {
      conceptsForArticle.push(node);
    }

    index.set(id, { item: node, file: null, locations: [] });
    result.created.push({ '@id': id, '@type': 'ko:Concept', file: `articles/${article['@id'].replace('ko:article/', '')}.jsonld` });
  }

  // ── Verify all referenced concept IDs exist ──
  for (const rel of ARTICLE_RELATION_KEYS) {
    for (const ref of [article[rel] ?? []].flat()) {
      if (ref.startsWith('ko:') && !index.has(ref)) {
        warn(`${rel}: "${ref}" not found in ontology — define it in newConcepts or check the @id`);
      }
    }
  }

  // ── Write article file ──
  const articleSlug = article['@id'].replace('ko:article/', '');
  const articlePath = join(__dir, 'articles', `${articleSlug}.jsonld`);

  if (existsSync(articlePath)) fatal(`articles/${articleSlug}.jsonld already exists`);

  const articleFile = {
    '@context': CONTEXT,
    '@graph':   [cleanArticle(article), ...conceptsForArticle],
  };
  writeJsonld(articlePath, articleFile);
  result.files[`articles/${articleSlug}.jsonld`] = 'created';

  // ── Write theme files if any ──
  for (const [themePath, nodes] of conceptsForTheme) {
    const themeData = existsSync(themePath)
      ? readJsonld(themePath)
      : { '@context': CONTEXT, '@graph': [] };
    themeData['@graph'].push(...nodes);
    writeJsonld(themePath, themeData);
    result.files[relPath(themePath)] = existsSync(themePath) ? 'updated' : 'created';
  }

  // ── Write shared.jsonld if modified ──
  if (sharedModified) {
    writeJsonld(sharedPath, sharedData);
    result.files['shared.jsonld'] = 'updated';
  }

  out(result);
}

// ── COMMAND: find ───────────────────────────────────────────────────────────────

function cmdFind(query) {
  if (!query) fatal('Usage: node ontology-cli.mjs find <keyword>');

  const q = query.toLowerCase();
  const results = [];

  for (const file of allJsonldFiles(__dir)) {
    const data = readJsonld(file);
    for (const item of data['@graph'] ?? []) {
      if (!item['@id']?.startsWith('ko:')) continue;

      const searchable = [
        item['@id'],
        item.prefLabel,
        item.title,
        item.name,
        item.definition,
        item.abstract,
        ...(Array.isArray(item.altLabel) ? item.altLabel : [item.altLabel]),
      ].filter(Boolean).join(' ').toLowerCase();

      if (searchable.includes(q)) {
        results.push({
          '@id':       item['@id'],
          '@type':     item['@type'],
          label:       item.prefLabel ?? item.title ?? item.name ?? null,
          definition:  (item.definition ?? item.abstract ?? '').slice(0, 120) || null,
          file:        relPath(file),
        });
      }
    }
  }

  out({ query, count: results.length, results });
}

// ── COMMAND: validate ───────────────────────────────────────────────────────────

function cmdValidate() {
  const errors   = [];
  const warnings = [];
  const idLocations = new Map(); // id → [filePaths]
  let fileCount = 0;

  const err  = (file, msg) => errors.push({ file, error: msg });
  const warn = (file, msg) => warnings.push({ file, warning: msg });

  for (const file of allJsonldFiles(__dir)) {
    fileCount++;
    const rel = relPath(file);
    const text = readFileSync(file, 'utf8');

    // JSON syntax
    let data;
    try { data = JSON.parse(text); }
    catch (e) { err(rel, `Invalid JSON: ${e.message}`); continue; }

    // SKILL.md anti-patterns
    if (/"@id"\s*:\s*"_:/.test(text))
      err(rel, 'Blank node IDs (@id starting with _:)');
    if (/"@type"\s*:\s*"(Concept|Property|Article|Author)"/.test(text))
      err(rel, 'Non-prefixed @type (e.g. "Concept" instead of "ko:Concept")');
    if (/"label"\s*:|"description"\s*:|"subconcepts"\s*:/.test(text))
      err(rel, 'Old-style property (label / description / subconcepts)');
    if (/"@context"\s*:\s*"http/.test(text))
      err(rel, 'Inline @context shortcut (@context should be the full object)');

    for (const item of data['@graph'] ?? []) {
      const id = item['@id'];
      if (!id?.startsWith('ko:')) continue;

      // Track locations for duplicate detection
      if (!idLocations.has(id)) idLocations.set(id, []);
      idLocations.get(id).push(rel);

      const type = item['@type'];

      // Required fields per type
      if (type === 'ko:Article') {
        if (!item.title)     err(rel, `${id}: missing title`);
        if (!item.url)       err(rel, `${id}: missing url`);
        if (!item.readDate)  warn(rel, `${id}: missing readDate`);

        // Resolve article → concept refs
        for (const rel2 of ARTICLE_RELATION_KEYS) {
          for (const ref of [item[rel2] ?? []].flat()) {
            if (ref.startsWith('ko:') && !idLocations.has(ref)) {
              // We'll do a second pass for this — skip for now
            }
          }
        }
      }

      if (type === 'ko:Concept') {
        if (!item.prefLabel)   err(rel, `${id}: missing prefLabel`);
        if (!item.definition)  warn(rel, `${id}: missing definition`);
        if (!item.domain)      warn(rel, `${id}: missing domain`);
      }

      if (type === 'ko:Author') {
        if (!item.name) err(rel, `${id}: missing name`);
      }
    }
  }

  // Build full index for reference checks
  const index = buildIndex();

  // Duplicate detection (excluding expected article↔theme duplicates)
  for (const [id, locs] of idLocations) {
    if (locs.length < 2) continue;

    const inArticle = locs.filter(f => f.startsWith('articles/'));
    const inTheme   = locs.filter(f => f.startsWith('themes/'));
    const inOther   = locs.filter(f => !f.startsWith('articles/') && !f.startsWith('themes/'));

    if (inOther.length > 0) {
      errors.push({ file: locs.join(', '), error: `${id}: defined in unexpected location(s): ${inOther.join(', ')}` });
    }
    if (inTheme.length > 1) {
      errors.push({ file: locs.join(', '), error: `${id}: defined in multiple theme files: ${inTheme.join(', ')}` });
    }
    if (inArticle.length > 1) {
      errors.push({ file: locs.join(', '), error: `${id}: defined in multiple article files: ${inArticle.join(', ')}` });
    }
    if (inArticle.length > 0 && inTheme.length > 0) {
      // This is the expected article↔theme duplication — flag as warning, not error
      warnings.push({ file: locs.join(', '), warning: `${id}: defined in both article and theme — consider promoting` });
    }
  }

  // Unresolved references (second pass)
  for (const file of allJsonldFiles(__dir)) {
    const rel = relPath(file);
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }

    for (const item of data['@graph'] ?? []) {
      if (item['@type'] !== 'ko:Article') continue;

      for (const key of ARTICLE_RELATION_KEYS) {
        for (const ref of [item[key] ?? []].flat()) {
          if (ref.startsWith('ko:') && !index.has(ref)) {
            err(rel, `${item['@id']}: ${key} references undefined "${ref}"`);
          }
        }
      }

      for (const a of [item.hasAuthor ?? []].flat()) {
        if (a.startsWith('ko:') && !index.has(a)) {
          err(rel, `${item['@id']}: hasAuthor references undefined "${a}"`);
        }
      }
    }
  }

  const ok = errors.length === 0;
  out({
    ok,
    files:    fileCount,
    errors:   errors.length,
    warnings: warnings.length,
    details:  { errors, warnings },
  });
  if (!ok) process.exit(1);
}

// ── COMMAND: promote ────────────────────────────────────────────────────────────
// Move a concept from an article file to a theme file.

function cmdPromote(conceptId, themeArg) {
  if (!conceptId || !themeArg)
    fatal('Usage: node ontology-cli.mjs promote <concept-id> <theme-file-or-name>\nExamples:\n  promote ko:concept/glue-work software-engineering\n  promote ko:concept/glue-work themes/software-engineering.jsonld');

  if (!conceptId.startsWith('ko:concept/'))
    fatal('concept-id must start with ko:concept/');

  const index = buildIndex();
  const entry = index.get(conceptId);
  if (!entry) fatal(`${conceptId} not found in ontology`);

  const sourceFile = entry.file;
  if (!relPath(sourceFile).startsWith('articles/'))
    fatal(`${conceptId} is in ${relPath(sourceFile)} — promote only moves concepts out of article files`);

  // Resolve theme file
  let themePath;
  if (themeArg.endsWith('.jsonld')) {
    themePath = themeArg.startsWith('/') ? themeArg : join(__dir, themeArg);
  } else {
    const candidate = join(__dir, 'themes', `${themeArg}.jsonld`);
    if (!existsSync(candidate)) {
      // Try to resolve via domain map
      themePath = resolveThemeFile(themeArg) ?? candidate; // create new theme if no match
    } else {
      themePath = candidate;
    }
  }

  // Remove from article file
  const articleData = readJsonld(sourceFile);
  const conceptNode = articleData['@graph'].find(i => i['@id'] === conceptId);
  articleData['@graph'] = articleData['@graph'].filter(i => i['@id'] !== conceptId);
  writeJsonld(sourceFile, articleData);

  // Add to theme file (create if needed)
  const themeExists = existsSync(themePath);
  const themeData = themeExists
    ? readJsonld(themePath)
    : { '@context': CONTEXT, '@graph': [] };
  const alreadyInTheme = themeData['@graph'].some(i => i['@id'] === conceptId);
  if (!alreadyInTheme) themeData['@graph'].push(conceptNode);
  writeJsonld(themePath, themeData);

  out({
    ok:           true,
    moved:        conceptId,
    from:         relPath(sourceFile),
    to:           relPath(themePath),
    created:      !themeExists,
    alreadyInTheme,
  });
}

// ── COMMAND: fix ─────────────────────────────────────────────────────────────────
// Auto-promote concepts from article files when they are linked (broader/narrower/related)
// to a concept already living in a theme file. Batches file I/O per source/target.

function cmdFix() {
  const index = buildIndex();

  // Collect promotions: conceptId → { sourceFile, targetThemePath, node }
  // We pick the *first* theme found via broader > narrower > related priority.
  const promotions = new Map(); // conceptId → { sourceFile, targetThemePath, node }

  for (const [id, entry] of index) {
    if (!id.startsWith('ko:concept/')) continue;
    if (!relPath(entry.file).startsWith('articles/')) continue;

    const concept = entry.item;
    const linkedIds = [
      ...[concept.broader  ?? []].flat(),
      ...[concept.narrower ?? []].flat(),
      ...[concept.related  ?? []].flat(),
    ];

    let targetThemePath = null;
    outer: for (const linkedId of linkedIds) {
      const linkedEntry = index.get(linkedId);
      if (!linkedEntry) continue;
      for (const loc of linkedEntry.locations) {
        if (relPath(loc.file).startsWith('themes/')) {
          targetThemePath = loc.file;
          break outer;
        }
      }
    }

    if (!targetThemePath) continue;

    // If the concept is already in any theme file, we only need to clean the article.
    const existingThemeLoc = entry.locations.find(
      loc => relPath(loc.file).startsWith('themes/')
    );

    promotions.set(id, { sourceFile: entry.file, targetThemePath, node: concept, existingThemePath: existingThemeLoc?.file ?? null });
  }

  if (promotions.size === 0) {
    out({ ok: true, promoted: [], cleaned: [], skipped: [] });
    return;
  }

  // Group by source article file → Set of concept IDs to remove
  const bySource = new Map(); // sourceFile → Set<conceptId>
  for (const [id, { sourceFile }] of promotions) {
    if (!bySource.has(sourceFile)) bySource.set(sourceFile, new Set());
    bySource.get(sourceFile).add(id);
  }

  // Group by target theme file → list of { id, node } to add (only new ones)
  const byTheme = new Map(); // targetThemePath → [{ id, node }]
  for (const [id, { targetThemePath, node, existingThemePath }] of promotions) {
    if (existingThemePath) continue; // already in a theme — only cleanup needed
    if (!byTheme.has(targetThemePath)) byTheme.set(targetThemePath, []);
    byTheme.get(targetThemePath).push({ id, node });
  }

  const result = { ok: true, promoted: [], cleaned: [], skipped: [] };

  // Remove concepts from article files (one read/write per file)
  for (const [sourceFile, ids] of bySource) {
    const data = readJsonld(sourceFile);
    data['@graph'] = data['@graph'].filter(i => !ids.has(i['@id']));
    writeJsonld(sourceFile, data);
  }

  // Add concepts to theme files (one read/write per file)
  for (const [targetThemePath, entries] of byTheme) {
    const data = readJsonld(targetThemePath);
    for (const { id, node } of entries) {
      const alreadyInTarget = data['@graph'].some(i => i['@id'] === id);
      const { sourceFile } = promotions.get(id);
      if (alreadyInTarget) {
        // Shouldn't normally happen (already caught above), but guard anyway
        result.skipped.push({ '@id': id, reason: 'already in target theme', from: relPath(sourceFile), to: relPath(targetThemePath) });
      } else {
        data['@graph'].push(node);
        result.promoted.push({ '@id': id, from: relPath(sourceFile), to: relPath(targetThemePath) });
      }
    }
    writeJsonld(targetThemePath, data);
  }

  // Record cleanups (concepts removed from article because already in a theme)
  for (const [id, { sourceFile, existingThemePath }] of promotions) {
    if (existingThemePath) {
      result.cleaned.push({ '@id': id, from: relPath(sourceFile), existsIn: relPath(existingThemePath) });
    }
  }

  out(result);
}

// ── Dispatch ────────────────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv;

const HELP = `
ontology-cli.mjs — JSON-LD ontology management

Commands:
  add-article             Read JSON payload from stdin, create article + concepts
  find <keyword>          Search concepts/articles by keyword
  validate                Check ontology for errors and unresolved references
  promote <id> <theme>    Move a concept from an article file to a theme file
  fix                     Auto-promote concepts linked (broader/narrower/related)
                          to a theme concept; batches all writes per file

Examples:
  cat payload.json | node ontology-cli.mjs add-article
  node ontology-cli.mjs find "property testing"
  node ontology-cli.mjs validate
  node ontology-cli.mjs promote ko:concept/glue-work software-engineering
  node ontology-cli.mjs fix
`.trim();

switch (command) {
  case 'add-article': await cmdAddArticle(args); break;
  case 'find':        cmdFind(args[0]); break;
  case 'validate':    cmdValidate(); break;
  case 'promote':     cmdPromote(args[0], args[1]); break;
  case 'fix':         cmdFix(); break;
  default:
    console.error(command ? `Unknown command: ${command}\n` : '');
    console.error(HELP);
    process.exit(command ? 1 : 0);
}
