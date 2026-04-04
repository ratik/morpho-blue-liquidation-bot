# Data Providers

Data providers are responsible for fetching market and position data for the Morpho Blue Liquidation Bot.

## Interface

Every data provider must implement the `DataProvider` interface (`src/dataProvider.ts`):

- **`init()`** (optional) — Async initialization (e.g. spinning up an indexer, waiting for backfill). Called once before the provider is used.
- **`fetchMarkets(client, vaults)`** — Returns the market IDs for the given vaults.
- **`fetchLiquidatablePositions(client, marketIds)`** — Returns liquidatable positions for the given market IDs.

Data providers are multi-chain: a single instance is shared across all chains. They are created in the script before bots are launched, and each bot receives its provider via dependency injection.

## Available Data Providers

### `morphoApi`

Queries the [Morpho API](https://docs.morpho.org/api) for liquidatable positions (with pagination) and reads vault markets on-chain. No infrastructure required. Does not support pre-liquidations.

### Configuration

Set the data provider in `apps/config/src/config.ts`:

```typescript
[mainnet.id]: {
  options: {
    // ...
  },
},
```

## Adding a New Data Provider

1. Create a new folder in `src/` with an `index.ts` implementing the `DataProvider` interface.
2. Register it in the bootstrap/factory path in `src/factory.ts`.
3. Export it from `src/index.ts`.
