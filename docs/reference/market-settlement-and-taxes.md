# What Happens When a Trade Settles

This guide explains what happens after a sale is agreed upon: how money changes hands, where taxes go, how the books are balanced, and what the recorded telemetry means.

## The Price the Seller Sees vs. the Price the Buyer Pays

The market posts one price: the **net seller unit price**. This is what sellers receive. But buyers pay more.

The difference is **consumption tax**.

### Calculating What the Buyer Owes

Starting from the net seller price, the buyer's true cost is:

```
buyer_gross_unit_price = net_seller_price + (net_seller_price × consumption_tax_rate × collection_efficiency)
```

For example:
- Net seller price: $100 per unit
- Consumption tax rate in the buyer's jurisdiction: 10%
- Collection efficiency: 95% (the State collects 95% of the tax it assesses)

Calculation:
- Assessed tax = $100 × 10% = $10
- Collected tax = $10 × 95% = $9.50
- Buyer gross price = $100 + $9.50 = $109.50

The buyer pays $109.50 total. The seller receives $100. The State treasury receives $9.50. The buyer keeps $0.50 as "assessed but uncollected" tax (recorded as telemetry only).

### Where Taxes Go

When a sale occurs:
1. The **buyer's wallet** is debited by the full gross price (including collected tax)
2. The **seller's wallet** is credited by the net price (tax-free)
3. The **State treasury** (if there is one in the buyer's jurisdiction) is credited by the collected tax

All three happen in one atomic transaction. Money is never created or destroyed—it moves from buyer to seller and to the State.

### Inventory Endpoint Rule

Goods move in parallel to money:
- The **seller's inventory** decreases by the quantity sold
- The **buyer's inventory** increases by the same quantity

For production units, the goods go into the specific inventory bucket (input, output, or investment goods) that was specified in the original purchase order. A buyer requesting "input goods" gets them in their input inventory, not a generic stockpile.

## Affordability Check During Settlement

After clearing determines a buyer's fill quantity, the settlement process validates that the buyer has enough cash to pay the gross price for that committed quantity. This is a revalidation—the buyer's maxSpend budget already bounded their fill during clearing. The settlement affordability check ensures this budget constraint is still satisfied as the transaction commits.

If the settlement preflight check fails (buyer lacks sufficient funds), the entire sale is rejected as a unit: no partial quantity reduction occurs, and all stocks remain unchanged. The sale is all-or-nothing. The market never allows negative cash balances or impossible transactions; atomic settlement means the preflight ensures all inventory and cash changes are valid before any mutation happens.

## Reconciliation: Transfers Balance, Stocks Are Accounted For

Two different guarantees live here, and conflating them is the easiest mistake to make when reading the ledger.

**A transfer is conserved.** Goods and transaction money reconcile exactly after every settlement. The seller's inventory decrement equals the buyer's increment for the traded good; the buyer's wallet debit equals the seller's credit plus the collected tax landing in the State treasury. Both sides of a transfer are recorded, so a transfer must net to zero. M2 phase-boundary reconciliation checks exactly this zero-flow property over the recorded transfer flows: money matched by `currencyId`, goods matched by `goodId`, independent of which actors hold them.

**A whole tick is not required to leave stock totals unchanged.** Reconciliation accounts for every change to a stock; it does not force the net change to zero. A change that is not a transfer is legitimate only when it is recorded as an explicit typed source or sink, attributed to the process that caused it. Anything else is an unaccounted flow, and that is what the check catches.

**Goods**: Trade is zero-sum for the traded good — it relocates quantity between actors without changing the total. Whole-tick goods totals may still change, and from M4 onward normally will, through typed physical sources and sinks: production creates output from real inputs, resources, labor and capacity; household consumption, spoilage, and physical loss (goods destroyed by events or transport shrinkage) remove it. Physical loss is a one-sided sink, recorded in its own category with its source attribution rather than as half of a transfer, and it is deliberately exempt from the zero-sum check. M3 itself has no production or consumption, so the only goods flows an M3 tick records are market transfers; the typed-sink machinery exists so those later flows are representable without ever looking like a transfer imbalance.

**Money**: Transaction money is stricter. Ordinary economic activity only ever moves it — a sale, a consumption tax, a wage payment are all transfers, from one actor's wallet to another's or to a State treasury, leaving the total in that currency unchanged. Production and consumption are physical processes: they change goods stocks, not money totals. Cash is a budget constraint on production, not an ingredient that can become output, and consuming a good destroys the good rather than any money. The total money in a currency changes only through explicitly authorized monetary or genesis operations, which are recorded as typed sources and sinks when those subsystems arrive in later milestones — never as ordinary transfer imbalance.

The reconciliation diagnostic tracks the category (MONEY or GOOD), the key (`currencyId` for MONEY, `goodId` for GOOD), and any residual unmatched amount. If any flow is unaccounted for, the diagnostic reports the exact discrepancy and category/key pair affected—how much is missing or extra for that currency or good ID.

This reconciliation happens automatically each tick. It's a core invariant: the system cannot tolerate an unaccounted flow.

## Telemetry: What Gets Recorded

Market telemetry records what actually happened, for diagnostics and visualization:

### Per-Market Telemetry
The realized M3 observation is produced once per tick, after Phase-8 MAIN local clearing — never after the Phase-4 pre-production pass. The market records:
- **Desired quantity**: How much did buyers want to buy, before any affordability limit?
- **Effective demand quantity**: How much of that desired quantity could buyers actually afford to commit? Affordability can make this lower than desired quantity; the two are tracked separately.
- **Offered quantity**: How much did sellers want to sell?
- **Cleared quantity**: How much actually changed hands?
- **Shortage rate**: `max(0, effectiveDemandQuantity - clearedQuantity) / effectiveDemandQuantity` (zero when effective demand is at or below the numeric epsilon threshold). What fraction of effective demand wasn't met?
- **Surplus rate**: `max(0, offeredQuantity - clearedQuantity) / offeredQuantity` (zero when offered quantity is at or below the numeric epsilon threshold). What fraction of supply went unsold?

### Authoritative Economic Transaction Records
For each sale, the system records two types of authoritative transaction records (not telemetry):
- **MARKET_SALE**: The good, quantity, seller net price, and both parties. This is the authoritative record of economic state mutation (who bought what for how much).
- **CONSUMPTION_TAX**: The tax amount, the destination (which State collects it), and a link back to the MARKET_SALE. This is the authoritative record of the tax transfer corresponding to that sale.

These records are part of the ledger and reconciliation; they carry economic truth.

### Important: Telemetry Is Read-Only Observation

Per-market telemetry (shortage rate, surplus rate, desired quantity, offered quantity) records what actually happened but never becomes economic truth. It is pure observation. The market does not look back at "shortage rate from last tick" to decide what price to set this tick. It looks at actual current supply and demand, and at lagged expected-use (which is a separate market-memory field, not telemetry).

Enabling or disabling telemetry recording does not change:
- The transactions that happen
- The prices set
- The goods that move
- The replay hash (deterministic output)

Telemetry is purely diagnostic output, never input to the economic engine.

## Tax Policy: Jurisdiction and Collection

Consumption tax is jurisdiction-specific. The rule is:
- If the buyer is in a controlled region (region with a State), that State's tax rate and collection efficiency apply
- If the buyer is in an uncontrolled region (no State), no consumption tax is collected

The tax policy is a read-only rule provided to the market at the start of each tick. It specifies:
- Tax rate (percentage of seller price)
- Collection efficiency (what fraction of assessed tax is actually collected)

For M3, these are fixtures—explicit test values injected into the market. They never come from hidden defaults. Later in M6, fiscal policy will own these numbers, but the interface remains the same.

## Example: A Complete Trade

Here's a concrete example:

1. **Setup**: A household in State A wants to buy 10 units of wheat at market price $12/unit. They have $150 cash.
2. **Tax Policy**: State A's consumption tax rate on grain is 8%, collection efficiency 100%.
3. **Calculation**:
   - Seller net price: $12
   - Assessed tax per unit: $12 × 8% = $0.96
   - Collected tax per unit: $0.96 × 100% = $0.96
   - Buyer gross price: $12 + $0.96 = $12.96
4. **Affordability**: Household needs $12.96 × 10 = $129.60. They have $150. ✓ Affordable.
5. **Settlement**:
   - Household wallet: $150 - $129.60 = $20.40 remaining
   - Seller wallet: +$120 (10 units × $12)
   - State A treasury: +$9.60 (10 units × $0.96)
   - Household inventory: +10 units of wheat
   - Seller inventory: -10 units of wheat
6. **Ledger Records**:
   - MARKET_SALE: household bought wheat from seller at $12/unit, 10 units
   - CONSUMPTION_TAX: $9.60 collected from household, destination State A
7. **Telemetry**: If demand was 10 and supply was 8, shortage rate was 20%. If all 8 units sold, surplus rate was 0%.

## Zero-Sum Principle

The fundamental principle: every transaction is zero-sum among the parties involved plus the collecting State. If a buyer spends $100:
- The seller gains $100 - tax paid
- The State gains the tax
- Total: $100 in, $100 out

Money never appears or disappears in a trade. It flows from one balance sheet to another, leaving a complete audit trail in the ledger. Creating or destroying money is not something a market can do; it belongs to the authorized monetary and genesis operations described above.
