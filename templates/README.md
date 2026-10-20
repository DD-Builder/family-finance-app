# Finance HQ — Import Templates

These templates define the canonical shape of every data slice the app
ingests. Drop the filled-in file into **step 1 of the setup wizard** or
at **/data/import** to bulk-load — the wizard pre-fills from your
upload and prompts for any gaps.

## Three ways to onboard

1. **`master.csv`** — one master spreadsheet with a `kind` first column.
   Each row is a single data point (one lot, one sale, one debt
   account, one employment year, etc.). Recommended for AI agents that
   want a single fill-in target. See "Master CSV" below.
2. **Per-slice CSVs** (`template-lots.csv`, `template-sales.csv`, etc.)
   — one file per data type. Recommended when you have a clean per-slice
   export from another tool already.
3. **JSON export** — full-state JSON matching the canonical store shape.
   Recommended for AI agents that already understand the schema. The
   importer is **tolerant**: common alternative key names like
   `household` (→ `planning`), `tax_rates` (→ `config.tax`),
   `staking_rewards` (→ `validators.rewards`), `lot_inventory` (→
   `lots.lots`) are silently remapped.

All CSVs are UTF-8, comma-delimited, with a single header row. Quoted
fields are RFC 4180 compliant — wrap any cell containing a comma,
newline, or double-quote in `"..."` and escape internal quotes by
doubling them (`""`).

## Master CSV (`master.csv`) — single-file onboarding

Every row's `kind` column tells the parser which slice it belongs to.
Most cells per row are empty — that's expected. Supported kinds:

| `kind` | Lands in | Required columns |
|---|---|---|
| `profile` | `planning` + `config.tax` | `name`, `birthYear` (rest optional: `spouseBirthYear`, `filingStatus`, `stateRate`, `standardDeduction`) |
| `tax` | `config.tax` | At least one of: `filingStatus`, `stateRate`, `standardDeduction` |
| `lot` | `lots.lots[]` | `symbol`, `qty`, `costPerUnit`, `acquiredDate` |
| `sale` | `sales.sales[]` | `symbol`, `qty`, `salePrice`, `saleDate` |
| `equity` | `equities.brokerage[]` or `.retirement[]` | `account`, `symbol`, `qty`, `costBasisPerShare`, `acquiredDate` (account names matching `401k|ira|roth|sep|simple|hsa|403b|457|pension` route to retirement) |
| `reward` | `validators.rewards[]` | `month` (YYYY-MM), one of `grossETH`/`netETH`, `avgPrice` |
| `validator` | `validators.list[]` | `pubkey` |
| `debt` | `debt.accounts[]` | `lender`, `principal`, `interestRate` (decimal — `0.0625` for 6.25%) |
| `vehicle` | `vehicles.vehicles[]` | `year`, `make`, `model`, `purchaseDate`, `purchasePrice` |
| `employment` | `planning.employmentHistory[]` + populates `income.employment` from latest year | `year`, `employer`, `grossWages` |
| `spending` | `spending.monthlyTotals[year][monthIdx]` (use `category=total`) or per-category aggregates | `month` (YYYY-MM), `amount` |

## Why historical data matters

This is not a snapshot tool. The dashboards that depend on **lots**,
**sales**, **rewards**, **equity purchases**, and **employment history**
are only as good as the history you give them:

- **Cost basis + capital gains** require every acquisition lot, not
  just current holdings. A $10 ETH bought in 2017 doesn't look
  anything like a $3,800 ETH bought in 2024 at tax time.
- **Tax-loss harvesting** suggestions are unsafe without lots — the
  TLH dashboard can recommend losses that get disallowed by the
  wash-sale rule (§1091) if it can't see your last 30 days of buys
  across all accounts.
- **Long vs short term** is a function of acquisition date. Without
  history, every sale looks short-term and every gain hits your
  ordinary rate.
- **401(k) / IRA contribution-limit checks** need year-by-year
  employment history, not just this year's W-2.
- **Net-worth time series** is meaningless from a single snapshot.

When in doubt, import more history. The schema is designed to absorb
years of records cleanly. The wash-sale, HIFO/FIFO/LIFO accounting
methods, and milestone tracking only earn their keep if you do.

## File index

| Template | Slice | Required fields |
|---|---|---|
| `template-lots.csv` | `lots` | `symbol`, `qty`, `avgCost`, `acquiredDate` |
| `template-sales.csv` | `sales` | `symbol`, `qty`, `salePrice`, `saleDate` |
| `template-rewards.csv` | `validators.rewards` | `month`, `netETH` (or `grossETH`), `avgPrice` |
| `template-debts.csv` | `debt.accounts` | `lender`, `principal`, `interestRate` |
| `template-spending.csv` | `spending.monthlyTotals` (+ optional categories) | `month`, `amount` (set `category=total` for the bare monthly total; or one row per category for a breakdown) |
| `template-validators.csv` | `validators.list` | `pubkey` |
| `template-equities.csv` | `equities.holdings` | `account`, `symbol`, `qty`, `costBasisPerShare`, `acquiredDate` |
| `template-employment.csv` | `employment.history` | `year`, `employer`, `grossWages`, `federalWithheld` |
| `template-vehicles.csv` | `vehicles.list` | `year`, `make`, `model`, `purchaseDate`, `purchasePrice` |

## Field reference

### lots — every taxable acquisition lot

| Field | Type | Notes |
|---|---|---|
| `lotId` | string | Optional. Stable id for cross-references. Auto-generated if omitted (`SYM-YYYYMM-xxxx`). |
| `symbol` | string | **Required.** Asset ticker (`ETH`, `BTC`, `AAPL`, etc.). Coerced to uppercase. |
| `qty` | number | **Required.** Positive. Up to 6 decimal places. |
| `avgCost` | number | **Required.** Cost per unit at acquisition (USD). |
| `acquiredDate` | YYYY-MM-DD | **Required.** Used for ST/LT holding period. Many slash formats accepted (`MM/DD/YYYY`, `DD/MM/YYYY` when day > 12). |
| `notes` | string | Optional. Free text. |

### sales — every disposition

| Field | Type | Notes |
|---|---|---|
| `saleId` | string | Optional; auto-generated if omitted. |
| `lotId` | string | Optional. Links the sale to a specific lot for HIFO/FIFO accounting. |
| `symbol` | string | **Required.** |
| `qty` | number | **Required.** Positive. |
| `salePrice` | number | **Required.** Per-unit. |
| `saleDate` | YYYY-MM-DD | **Required.** |
| `proceeds` | number | Optional; derived from `qty × salePrice` if absent. |
| `fees` | number | Optional; defaults to `0`. |

### rewards — staking / yield income (monthly)

| Field | Type | Notes |
|---|---|---|
| `month` | YYYY-MM | **Required.** Reward month. Date strings are accepted and downgraded to month. |
| `grossETH` | number | One of `grossETH` / `netETH` is **required**; the other defaults to it. |
| `netETH` | number | After-penalty net. |
| `avgPrice` | number | **Required.** FMV at receipt. Used to compute taxable income. |
| `penalties` | number | Optional; defaults to `0`. |
| `consensus`, `blockFees`, `mev` | number | Optional decomposition. |
| `notes` | string | Optional. |

### debts — debt accounts

| Field | Type | Notes |
|---|---|---|
| `accountId` | string | Optional; auto-generated. |
| `lender` | string | **Required.** |
| `principal` | number | **Required.** Outstanding balance. |
| `interestRate` | decimal | **Required.** As a fraction (0.0625 = 6.25%, NOT 6.25). |
| `collateral` | number | Optional. Crypto- or asset-backed lines. |
| `minPayment` | number | Optional. |
| `notes` | string | Optional. |

### spending — monthly totals

| Field | Type | Notes |
|---|---|---|
| `month` | YYYY-MM | **Required.** |
| `category` | string | Optional; defaults to `"uncategorized"`. Use `"total"` for monthly aggregate. |
| `amount` | number | **Required.** |
| `notes` | string | Optional. |

### validators — Ethereum validators

| Field | Type | Notes |
|---|---|---|
| `pubkey` | string | **Required.** 96-char hex with `0x` prefix. |
| `activatedDate` | YYYY-MM-DD | Optional. |
| `status` | string | Optional. Defaults to `"active"`. |

### equities — every brokerage / 401(k) / IRA purchase

One row per **lot** (purchase batch). Aggregating to current shares-held
loses cost basis history; resist the temptation to summarize.

| Field | Type | Notes |
|---|---|---|
| `holdingId` | string | Optional. Stable id for cross-references. |
| `account` | string | **Required.** Brokerage / 401k / IRA name (e.g. `Schwab Brokerage`, `Fidelity 401k`). |
| `symbol` | string | **Required.** Ticker. Coerced to uppercase. |
| `qty` | number | **Required.** Shares. Up to 6 decimal places (covers DRIP fractional shares). |
| `costBasisPerShare` | number | **Required.** Per-share cost at purchase (USD). |
| `acquiredDate` | YYYY-MM-DD | **Required.** Used for ST/LT holding period. |
| `lotId` | string | Optional. Links to a specific tax lot if your broker tracks them. |
| `reinvestedDividend` | bool | Optional. `true` for DRIP / dividend-reinvest lots — the IRS treats these the same as cash purchases for cost-basis purposes. |
| `notes` | string | Optional. |

### employment — W-2 / income history per year

| Field | Type | Notes |
|---|---|---|
| `year` | YYYY | **Required.** Tax year. |
| `employer` | string | **Required.** |
| `grossWages` | number | **Required.** Box 1 of the W-2. |
| `federalWithheld` | number | **Required.** Box 2. |
| `stateWithheld` | number | Optional. |
| `socialSecurityWages` | number | Optional. Box 3. |
| `medicareWages` | number | Optional. Box 5. |
| `k401Contribution` | number | Optional. Pre-tax 401(k) contribution for the year. |
| `k401Match` | number | Optional. Employer match. |
| `hsa` | number | Optional. HSA contribution. |
| `fsa` | number | Optional. FSA contribution. |
| `bonusGross` | number | Optional. Discretionary cash bonus. |
| `rsuVested` | number | Optional. FMV of RSUs that vested in the year. |
| `notes` | string | Optional. |

### vehicles — cars, motorcycles, boats

| Field | Type | Notes |
|---|---|---|
| `vehicleId` | string | Optional. |
| `year` | YYYY | **Required.** Model year. |
| `make` | string | **Required.** |
| `model` | string | **Required.** |
| `vin` | string | Optional. |
| `purchaseDate` | YYYY-MM-DD | **Required.** |
| `purchasePrice` | number | **Required.** |
| `currentValue` | number | Optional. KBB / latest estimate. |
| `mileage` | number | Optional. |
| `loanAccountId` | string | Optional. Links to a `debts` row's `accountId`. |
| `notes` | string | Optional. |

## Number formatting

The importer accepts:

- Plain numbers: `1234.56`
- Currency formatting: `$1,234.56`
- Parens-as-negative: `(500)` → `-500`
- Underscores or spaces as thousands separators: `1_000_000`

## Date formatting

Accepted: `YYYY-MM-DD` (canonical), `MM/DD/YYYY`, `DD/MM/YYYY` (when day > 12),
2-digit years (`24` → `2024`, `95` → `1995`), and most `Date.parse`-able
strings (`Jan 15 2024`, ISO-with-time).

## Common gotchas

- **Coinbase Retail exports** mix buys and sells. Filter to Buys before
  importing as `lots`; filter to Sells before importing as `sales`.
- **Kraken ledgers** split each trade across two rows. Import only
  `type=trade` rows; the importer doesn't yet pair them automatically.
- **Schwab realized exports** include `Open Date` (acquired) and
  `Close Date` (sold). Both are read.
- **Interest rates** are decimals: `0.055` for 5.5%, NOT `5.5`.
- **Symbols** are uppercased on import. `eth`, `ETH`, and `Eth` collide.
