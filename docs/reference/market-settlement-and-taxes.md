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

## Affordability Check

Before a sale completes, the market validates that the buyer has enough cash to pay the gross price for the quantity they're buying. If not, the purchase is reduced to what they can afford, or rejected entirely.

The market never allows negative cash balances or impossible transactions. A preflight check ensures all inventory and cash changes are valid before any mutation happens.

## Reconciliation: Goods and Money Balance

After every tick, the system checks that goods and money are conserved:

- **Goods:** The total quantity of each good across all actors should only change through:
  - Production (creating new goods)
  - Consumption (destroying goods)
  - Physical loss (goods destroyed by events or transport shrinkage)
  - Explicit trades (one actor loses exactly what another gains)

- **Money:** The total money in each currency should only change through:
  - Taxation (State takes collected taxes from buyers)
  - Wage payments (producing value)
  - Intentional destruction (if ever used)
  - Explicit transfers (one actor loses exactly what another gains)

The reconciliation ledger tracks every transaction's effect on these totals. If any flow is unaccounted for, the ledger reports the exact discrepancy: which actor, which currency or good, and how much is missing or extra.

This reconciliation happens automatically each tick. It's a core invariant: the system cannot tolerate accounting errors.

## Telemetry: What Gets Recorded

Market telemetry records what actually happened, for diagnostics and visualization:

### Per-Market Telemetry
After each phase, the market records:
- **Desired quantity**: How much did buyers want to buy (at their budget limits)?
- **Offered quantity**: How much did sellers want to sell?
- **Cleared quantity**: How much actually changed hands?
- **Shortage rate**: (desired - cleared) / desired. What fraction of demand wasn't met?
- **Surplus rate**: (offered - cleared) / offered. What fraction of supply went unsold?

### Transaction-Level Telemetry
For each sale, the ledger records:
- **MARKET_SALE**: The good, quantity, seller net price, and both parties
- **CONSUMPTION_TAX**: The tax amount, the destination (which State collects it), and a link back to the sale

### Important: Telemetry Is Read-Only

Telemetry never becomes economic truth. It is pure observation. The market does not look back at "shortage rate from last tick" to decide what price to set this tick. It looks at actual current supply and demand, and at lagged expected-use (which is a separate market-memory field, not telemetry).

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

Money never appears or disappears. It flows from one balance sheet to another, leaving a complete audit trail in the ledger.
