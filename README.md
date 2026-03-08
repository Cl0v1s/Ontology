# Mon Ontology: Base de Connaissances pour la Réflexion et l'Organisation du Travail

## Objectif

Cette ontologie est ma base de connaissances personnelle, conçue pour soutenir ma réflexion critique, mon apprentissage continu et l'organisation de mon travail. Elle intègre des insights d'articles, d'essais et de recherches sur des sujets comme :
- **Leadership Technique**
- **Parcours de Carrière en Ingénierie Logicielle**
- **Succès d'Équipe et Collaboration**
- **Collapsologie et Pensée Systémique**

L'objectif est de pouvoir :
1. Récupérer des concepts, relations et insights pertinents pour mes réflexions.
2. Organiser mes tâches de travail en m'appuyant sur les schémas ou meilleures pratiques apprises.
3. Obtenir des synthèses structurées ou des recommandations actionnables à partir de cette connaissance.

## Structure

The ontology is organized into two main components:

### 1. Articles

Stores parsed articles in JSON-LD format, with metadata and extracted concepts. Each article file (e.g., `noidea-dog-glue.jsonld`) contains:
- **Title** and **URL** of the source.
- **Extracted concepts** linked to the shared ontology.
- **Contextual information** like author, publication date, or tags.

Example articles:
- [Being Glue - No Idea Blog](https://www.noidea.dog/glue)
- [The Two Kinds of Error - Evan Hahn](https://evanhahn.com/the-two-kinds-of-error/)

### 2. Concepts (`shared.jsonld`)

Defines the core concepts and their relationships, such as:
- **Glue Work**: The role of connecting teams or projects.
- **Technical Leadership**: Skills and practices for leading technical teams.
- **Career Path**: Evolution in software engineering roles.
- **Team Success**: Factors contributing to effective collaboration.

## Functionality

### Intégration

Les articles sont analysés et leurs concepts liés à l'ontologie partagée. Je peux ajouter de nouveaux articles en utilisant la compétence `ontology`, qui :
1. Récupère le contenu de l'article.
2. Extrait les concepts clés et entités.
3. Les lie aux concepts existants ou en crée de nouveaux.
4. Valide et commette les changements.

### Exemples d'Utilisation

- **Pratique Réflexive** : Interroger l'ontologie pour obtenir des insights sur un sujet spécifique (ex: "Comment le 'Glue Work' impacte-t-il la réussite d'une équipe ?").
- **Organisation du Travail** : Récupérer les meilleures pratiques ou schémas à partir d'articles liés à mes tâches actuelles.
- **Exploration des Concepts** : Naviguer dans les relations entre concepts pour découvrir des connexions plus profondes.



#

## Perspectives d'Évolution

Je prévois d'élargir cette ontologie pour inclure d'autres domaines pertinents, comme la gestion de projet ou l'éthique. À terme, je souhaite ajouter des capacités de requête pour extraire des insights ou générer des synthèses à partir de cette base de connaissances.

---