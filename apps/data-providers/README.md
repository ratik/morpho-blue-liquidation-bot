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
    dataProvider: "morphoApi",
    // ...
  },
},
```

## Adding a New Data Provider

1. Add the data provider name to the `DataProviderName` type in `apps/config/src/types.ts`.
2. Create a new folder in `src/` with an `index.ts` implementing the `DataProvider` interface.
3. Register it in the factory switch in `src/factory.ts`.
4. Export it from `src/index.ts`.
5. Set `options.dataProvider` in the relevant chain configs in `apps/config/src/config.ts`.
