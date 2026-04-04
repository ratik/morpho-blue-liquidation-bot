import type { DataProvider } from "./dataProvider";
import { MorphoApiDataProvider } from "./morphoApi";

/**
 * Creates data providers for the given chains.
 * Returns a Map from chainId to DataProvider.
 * Multi-chain providers share a single instance across all chains.
 */
export async function createDataProviders(chainIds: number[]): Promise<Map<number, DataProvider>> {
  const provider: DataProvider = new MorphoApiDataProvider();

  if (provider.init) {
    await provider.init();
  }

  const map = new Map<number, DataProvider>();
  for (const chainId of chainIds) {
    map.set(chainId, provider);
  }
  return map;
}
