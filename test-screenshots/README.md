# Test Screenshots

Drop any `.png`, `.jpg`, `.jpeg`, or `.webp` file in here and run the
screenshot stress test to validate the vision import pipeline against
production:

```bash
TEST_BASE_URL=https://stash-backend-production-5aac.up.railway.app \
  node src/scripts/screenshotImportTest.js
```

## File naming

Use descriptive kebab-case filenames — they're shown in the test output
as the label so you can quickly see what each one is:

```
restaurant-dishoom-covent-garden.png   →  "Restaurant Dishoom Covent Garden"
amazon-echo-dot-listing.jpg             →  "Amazon Echo Dot Listing"
nytimes-article-headline.png            →  "Nytimes Article Headline"
```

Subfolders work too — the runner finds files recursively. Useful for
grouping by category:

```
test-screenshots/
├── places/
│   ├── restaurant-dishoom.png
│   └── hotel-shoreditch-house.jpg
├── products/
│   ├── amazon-echo-dot.png
│   └── ikea-kallax.jpg
└── articles/
    └── nytimes-tech-article.png
```

## What gets tested

Each screenshot is uploaded via `POST /api/imports/screenshot` and
polled until completion. The test reports for each file:

- `name` — what the AI extracted as the item name
- `type` — the assigned `item_type` (product/place/article/etc.)
- `image=✓` or `image=✗` — whether an image URL was extracted
- Duration in seconds

Files in this directory are git-ignored (except this README) so you
can drop personal/private screenshots without worry.
