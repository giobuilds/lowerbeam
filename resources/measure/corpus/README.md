# ledgerline

A small library for reading a plain-text spending log and reporting on it.
Each line of a log is `date, category, amount`, for example:

    2026-01-03, Groceries, 12.50

- `src/parse.js` reads lines into entries.
- `src/money.js` formats and rounds amounts.
- `src/categories.js` puts category names into one form.
- `src/dates.js` checks and compares dates.
- `src/budget.js` says how much of a budget is spent.
- `src/report.js` totals entries by month and category.
- `src/store.js` loads and saves a ledger file.

Run the tests with `node test/run.mjs`, or one suite with `node test/run.mjs money`.
