# How'z that! — research pages

Each `*.md` file in this folder is one paper page in the "How'z that!" section. The app loads every file
here automatically (`import.meta.glob`), so adding a paper means adding a file. Files starting with `_`
are not papers (`_integrated.md` is the integrated paper). This README is ignored by the app.

## Rules (agreed by the team)

1. Only list a paper that someone on the team has read and can explain. Until then set `reviewed: false`;
   the page shows a DRAFT label.
2. Check every citation against the publisher page or Google Scholar, then set `citationVerified: true`.
3. "Result" only contains numbers we measured. Otherwise write "Not measured yet".
4. Say what we changed or rejected, and where in our code the idea lives.

## Front matter

```
---
title: Paper title
authors: Last, F. and Last, F.
year: 1996
venue: Where it was published
doi: 10.xxxx/yyyy            (or leave empty)
url: https://...             (optional, a readable copy)
area: systems | behavioral
status: implemented | partial | planned | rejected
reviewed: false              (true once a teammate has read it and can answer questions)
citationVerified: true
summary: One line shown on the card.
seeAlso: other-slug, another-slug
order: 10                    (sort order on the list)
---
```

## Sections (use exactly these headings; leave any out that you have not written yet)

`## Research question`, `## Problem they solved`, `## What they did`, `## Findings` (as reported by the authors, never TickForge's own results), `## What we took`, `## What we changed or rejected`,
`## Where in our code`, `## How we verified it`, `## Result`, `## Limits and trade-offs`,
`## Why it matters for TickForge` (reading-list stubs only), `## Citation notes`.

Inside a section: paragraphs, `- ` bullet lists, `inline code`, **bold**, [links](https://...) and
`[[other-slug]]` links to another paper page.
