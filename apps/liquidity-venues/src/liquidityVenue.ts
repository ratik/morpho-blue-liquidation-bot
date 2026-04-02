import type { ExecutorEncoder } from "executooor-viem";
import type { Account, Address, Chain, Client, Transport } from "viem";

import type { ToConvert } from "./types";

export type LiquidityVenueKind = "transform" | "swap";
export type LiquidityVenueClient = Client<Transport, Chain, Account>;

/**
 * Liquidity venues are used to convert an amount from a source token to a destination token.
 * All liquidity venues must implement this interface.
 */
export interface LiquidityVenue {
  /**
   * Venue class used by the bot to apply deterministic unwrap/redeem steps before swap venues.
   */
  kind: LiquidityVenueKind;

  /**
   * Optional startup hook for prewarming caches before liquidations begin.
   */
  init?(client: LiquidityVenueClient): Promise<void> | void;

  /**
   * Optional background loop for keeping venue caches fresh outside the liquidation path.
   */
  startBackgroundSync?(client: LiquidityVenueClient): void;

  /**
   * Optional cleanup hook for background sync resources.
   */
  stopBackgroundSync?(): Promise<void> | void;

  /**
   * Optional hook to register token pairs that should be refreshed in the background.
   */
  registerTokenPair?(src: Address, dst: Address): void;

  /**
   * Whether the venue is adapted to the conversion.
   */
  supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address): Promise<boolean> | boolean;

  /**
   * Convert the amount from src to dst.
   */
  convert(executor: ExecutorEncoder, toConvert: ToConvert): Promise<ToConvert> | ToConvert;
}
