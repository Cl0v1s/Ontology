#!/usr/bin/env node
/**
 * Generates a Graphviz DOT diagram from the JSON-LD ontology files.
 *
 * Usage:
 *   node generate-mermaid.mjs                  # all relations
 *   node generate-mermaid.mjs --mode concepts  # concept→concept only
 *   node generate-mermaid.mjs --mode articles  # article→concept only
 *
 * Render with:
 *   node generate-mermaid.mjs | dot -Tsvg -o ontology.svg
 *   node generate-mermaid.mjs | dot -Tpng -o ontology.png
 */

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

const MODES = ["all", "concepts", "articles"];
const mode = (() => {
  const i = process.argv.indexOf("--mode");
  const m = i !== -1 ? process.argv[i + 1] : "all";
  if (!MODES.includes(m)) {
    console.error(`Unknown mode "${m}". Valid: ${MODES.join(", ")}`);
    process.exit(1);
  }
  return m;
})();

// Keys that are never relational (literal values only)
const SKIP_KEYS = new Set([
  "@id", "@type", "prefLabel", "altLabel", "definition", "abstract",
  "title", "url", "publishedDate", "readDate", "language", "domain",
  "name", "affiliation", "rdfs:label", "rdfs:comment", "owl:versionInfo",
  "example", "notes",
]);

// Visual style per relation
const EDGE_STYLES = {
  introduces:   'color="#2563eb" fontcolor="#2563eb" style=bold',
  uses:         'color="#6b7280" style=dashed',
  critiques:    'color="#dc2626" fontcolor="#dc2626"',
  exemplifies:  'color="#7c3aed" fontcolor="#7c3aed" style=dotted',
  hasFeature:   'color="#0891b2" fontcolor="#0891b2"',
  usesLanguage: 'color="#059669" fontcolor="#059669"',
  hasAuthor:    'color="#9ca3af" style=dashed arrowhead=none',
  broader:      'color="#92400e" fontcolor="#92400e" arrowhead=empty',
  narrower:     'color="#92400e" fontcolor="#92400e" style=dashed arrowhead=empty',
  related:      'color="#6d28d9" fontcolor="#6d28d9" arrowhead=none dir=none style=dotted',
};

function isKoRef(value) {
  return typeof value === "string" && value.startsWith("ko:");
}

function extractRefs(value) {
  if (isKoRef(value)) return [value];
  if (Array.isArray(value)) return value.filter(isKoRef);
  return [];
}

function* jsonldFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonldFiles(full);
    else if (entry.name.endsWith(".jsonld")) yield full;
  }
}

const nodes = new Map(); // id → { label, type, domain }
const edges = [];        // { src, rel, dst }

for (const file of jsonldFiles(__dir)) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    process.stderr.write(`⚠ Invalid JSON: ${file}\n`);
    continue;
  }

  for (const node of data["@graph"] ?? []) {
    const nid = node["@id"] ?? "";
    if (!nid.startsWith("ko:")) continue;

    const ntype = node["@type"] ?? "";
    let label;
    if (ntype === "ko:Concept")      label = node.prefLabel ?? nid.split("/").at(-1);
    else if (ntype === "ko:Article") label = node.title ?? nid.split("/").at(-1);
    else if (ntype === "ko:Author")  label = node.name ?? nid.split("/").at(-1);
    else continue;

    nodes.set(nid, { label, type: ntype, domain: node.domain ?? "" });

    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      for (const ref of extractRefs(value)) {
        edges.push({ src: nid, rel: key, dst: ref });
      }
    }
  }
}

function toId(koRef) {
  return koRef.replace("ko:", "").replace(/[/:\-]/g, "_");
}

function q(str) {
  return `"${str.replace(/"/g, "'")}"`;
}

function shouldInclude({ src, dst }) {
  const srcType = nodes.get(src)?.type;
  const dstType = nodes.get(dst)?.type;
  if (mode === "concepts") return srcType === "ko:Concept" && dstType === "ko:Concept";
  if (mode === "articles") return srcType === "ko:Article";
  return true;
}

function nodeAttrs(type) {
  switch (type) {
    case "ko:Article": return 'shape=box style="filled,rounded" fillcolor="#dbeafe" color="#3b82f6" fontcolor="#1e40af"';
    case "ko:Concept": return 'shape=ellipse style=filled fillcolor="#dcfce7" color="#22c55e" fontcolor="#166534"';
    case "ko:Author":  return 'shape=diamond style=filled fillcolor="#fef9c3" color="#eab308" fontcolor="#713f12"';
    default:           return "";
  }
}

// Group concepts by domain for clusters
const domainClusters = new Map(); // domain → Set of nids
for (const [nid, { type, domain }] of nodes) {
  if (type !== "ko:Concept" || !domain) continue;
  if (!domainClusters.has(domain)) domainClusters.set(domain, new Set());
  domainClusters.get(domain).add(nid);
}

const lines = [
  "digraph ontology {",
  '  graph [rankdir=LR fontname="Helvetica" bgcolor="#fafafa" pad=0.5 nodesep=0.6 ranksep=1.2]',
  '  node  [fontname="Helvetica" fontsize=11]',
  '  edge  [fontname="Helvetica" fontsize=9]',
  "",
];

// Emit concept clusters grouped by domain
const clusteredNodes = new Set();
let clusterIndex = 0;
for (const [domain, nids] of domainClusters) {
  if (mode === "articles") break; // no concept clusters in articles mode
  lines.push(`  subgraph cluster_${clusterIndex++} {`);
  lines.push(`    label=${q(domain)} style=filled fillcolor="#f8fafc" color="#cbd5e1" fontsize=10`);
  for (const nid of nids) {
    const { label } = nodes.get(nid);
    lines.push(`    ${toId(nid)} [label=${q(label)} ${nodeAttrs("ko:Concept")}]`);
    clusteredNodes.add(nid);
  }
  lines.push("  }");
  lines.push("");
}

// Emit remaining nodes (articles, authors, concepts without domain)
for (const [nid, { label, type }] of nodes) {
  if (clusteredNodes.has(nid)) continue;
  lines.push(`  ${toId(nid)} [label=${q(label)} ${nodeAttrs(type)}]`);
}

lines.push("");

// Emit edges
for (const { src, rel, dst } of edges.filter(shouldInclude)) {
  const style = EDGE_STYLES[rel] ?? 'color="#9ca3af"';
  lines.push(`  ${toId(src)} -> ${toId(dst)} [label=${q(rel)} ${style}]`);
}

lines.push("}");

console.log(lines.join("\n"));
