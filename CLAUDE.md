# Instructions pour agents IA — Base de connaissances ontologique

## Structure des fichiers

```
ontology/
├── ontology.jsonld          — définition des classes et propriétés (ne pas modifier)
├── articles/
│   └── <slug>.jsonld        — un fichier par article, avec ses concepts propres
└── concepts/
    └── shared.jsonld        — auteurs, ConceptScheme, concepts partagés entre articles
```

## Ajouter un article

Créer `articles/<auteur>-<slug-du-titre>.jsonld` contenant :
1. L'entité article
2. Tous les concepts que cet article introduit ou utilise **qui ne sont pas déjà définis ailleurs**

Ne pas modifier les autres fichiers d'articles existants.

### Règle de répartition des concepts

| Situation | Emplacement |
|-----------|-------------|
| Concept référencé par un seul article | Dans le fichier de cet article |
| Concept référencé par plusieurs articles | Dans `concepts/shared.jsonld` |
| Auteur | Toujours dans `concepts/shared.jsonld` |

Si un concept déjà défini dans un fichier d'article devient partagé, le déplacer vers `concepts/shared.jsonld` et supprimer sa définition du fichier d'article.

## Format JSON-LD

Chaque fichier commence par ce `@context` (copier tel quel) :

```json
{
    "@context": {
        "owl": "http://www.w3.org/2002/07/owl#",
        "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
        "skos": "http://www.w3.org/2004/02/skos/core#",
        "dc": "http://purl.org/dc/elements/1.1/",
        "dcterms": "http://purl.org/dc/terms/",
        "xsd": "http://www.w3.org/2001/XMLSchema#",
        "ko": "http://knowledge.local/ontology#"
    },
    "@graph": [ ... ]
}
```

## Conventions d'ID

- Article : `ko:article/<auteur><année>` ou `ko:article/<slug-descriptif>`
- Concept : `ko:concept/<slug-en-minuscules-avec-tirets>`
- Auteur   : `ko:author/<slug-du-nom>`

Les slugs sont en anglais, en minuscules, sans accents, avec des tirets.

## Structure d'un article

```json
{
    "@id": "ko:article/<slug>",
    "@type": "ko:Article",
    "title": "...",
    "url": "...",
    "publishedDate": "YYYY-MM-DD",
    "readDate": "YYYY-MM-DD",
    "language": "en",
    "abstract": "...",
    "hasAuthor": "ko:author/<slug>",
    "introduces": ["ko:concept/..."],
    "uses": ["ko:concept/..."],
    "critiques": ["ko:concept/..."]
}
```

Propriétés article → concept disponibles (définies dans `ontology.jsonld`) :
- `introduces` — l'article définit/introduit ce concept (relation centrale)
- `uses` — l'article mobilise le concept sans le définir
- `critiques` — l'article discute critiquement le concept
- `exemplifies` — l'article illustre le concept
- `describes` — relation générique (parent des précédentes, à éviter)

## Structure d'un concept

```json
{
    "@id": "ko:concept/<slug>",
    "@type": "ko:Concept",
    "prefLabel": "Nom Officiel du Concept",
    "altLabel": ["synonyme 1", "synonyme 2"],
    "definition": "...",
    "domain": "software engineering"
}
```

Propriétés concept → concept disponibles :
- `broader` / `narrower` — hiérarchie
- `related` — relation symétrique

## Références croisées

Les `@id` sont globaux. Un article peut référencer `"ko:author/lethain"` défini dans `concepts/shared.jsonld` sans import explicite — c'est valide en JSON-LD.

## Avant de créer un concept

Vérifier qu'il n'existe pas déjà dans les fichiers existants avec `grep -r` sur le slug envisagé. Si le concept existe, référencer son `@id` plutôt que le redéfinir.
