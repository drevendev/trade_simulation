# How the Local Market Works

This guide explains how M3 local markets function: how prices form, how clearing works, and what shortage and surplus signals mean.

## The Market Price

Every local market maintains a single price for each good, called the **net seller unit price**. This is the price the seller receives per unit of good sold, measured in the region's settlement currency.

The market price does not include taxes or buyer-facing costs. When a buyer purchases, they pay more than the listed market price because they add consumption tax (if applicable in their jurisdiction). M3 intents have no limit price or ask price; all matched lots clear at the persistent market price.

### How Price Changes

Prices adjust exactly once per tick, in Phase 6, based on two signals:

1. **Shortage/Surplus**: If buyers want more of a good than sellers offer, the market has excess demand and the price rises. If sellers offer more than buyers want, the market has excess supply and the price falls.

2. **Inventory Coverage**: Markets also look at whether inventory is piling up or getting depleted. If there's less inventory than the market expects to use, prices tend to rise. If there's more inventory than expected, prices tend to fall.

The price adjusts within configured bounds—it cannot move too much in a single tick, and it has minimum and maximum price floors/ceilings.

## Market Clearing and Orders

When a buyer or seller enters a local market, they submit a **market intent** describing what they want:

- **Buyers** specify: how much they want to buy, and their maximum budget
- **Sellers** specify: how much they want to sell, and how much they must keep in reserve

The market then **clears**—it matches buyers and sellers and settles transactions. The clearing process is **deterministic and proportional**: the cleared quantity is `Q = min(total sellable supply, total effective demand)`. Seller fills are proportional to sellable supply, and buyer fills are proportional to effective demand.

- When supply exceeds demand (total sellable > total effective demand), buyers are normally fully filled at their requested quantities, while sellers are rationed proportionally to what they offered
- When demand exceeds supply (total effective demand > total sellable), sellers normally sell all their sellable supply, while buyers are rationed proportionally to what they requested

Every unit cleared uses the same market price. There is no negotiation or price discrimination per order.

## Shortage and Surplus

After the main market clearing completes (Phase 8), the market observes two key signals:

- **Shortage Rate**: What fraction of buyer demand could not be satisfied? If every buyer got what they wanted, this is 0%. If half the goods buyers wanted were unavailable, this is 50%.

- **Surplus Rate**: What fraction of seller supply was left unsold? If every seller sold everything they offered, this is 0%. If half the goods sellers offered went unsold, this is 50%.

These observed rates are **Phase-8 MAIN observations, computed after the tick's Phase-6 repricing**. They do not cause the current tick's price move; that price change was already determined in Phase 6 based on current effective demand, sellable supply, and inventory coverage. The observed shortage/surplus rates inform future price adjustments through market expectations.

The market does not invent these numbers; they are computed directly from actual supply and demand each tick. They are **read-only telemetry** of what happened, not state that influences the current tick's clearing or pricing.

## Why Deterministic Ordering Matters

The market always processes intents in a stable, consistent order based on actor ID and intent ID, never based on insertion order or random shuffling. This ensures that:

- The same scenario produces identical results every time it runs
- The results don't change based on arbitrary implementation details like dictionary order
- Changing which region processes first, or which buyer submits first, doesn't change who gets scarce goods

This determinism is essential for testing, debugging, and trusting the simulation.

## Market Expectations

Over many ticks, the market learns approximate patterns through exponential moving averages (EMAs):

- **Expected Use**: The market remembers roughly how much effective demand for this good there is each tick. This is the sum of what all actors want to use, not the sum of what they actually get to use (which may be constrained by rationing). This distinction is intentional: when shortage occurs, the market still learns what buyers actually wanted, not just what they obtained.
- **Expected Shortage**: The market notes whether shortages are common or rare
- **Expected Surplus**: The market notes whether surpluses are common or rare

These expectations are **not** inventories or financial assets. They are just weak memories of past patterns that help inform price adjustments. They cannot be bought, sold, or consumed. A market with zero expected use still sets prices based on current supply and demand.

In the first tick a good trades, the market uses current effective demand and sellable supply only. After the first observation, it switches to using the lagged expected-use EMA in the price formula, making price movements less erratic as patterns stabilize.

## No Limits, No Order Books

There are no limit prices in the canonical M3 market. Buyers and sellers cannot specify "buy only if price is below $X." Instead, they submit explicit quantity and budget targets, and the market clears them at the posted price. Bounded price adjustment plus explicit budgets and quantities are the market mechanism—that's how actors influence what happens.

There is no order book or backlog. If an order isn't filled, it doesn't carry over to the next tick. Each tick, the market clears fresh from the current intents, prices, and inventories.
