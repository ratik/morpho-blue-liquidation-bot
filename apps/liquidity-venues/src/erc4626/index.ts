import type { ExecutorEncoder } from "executooor-viem";
import { erc4626Abi, zeroAddress, type Address } from "viem";

import type { LiquidityVenue } from "../liquidityVenue";
import { readContractWithRpcStats } from "../rpcActions";
import type { ToConvert } from "../types";

export class Erc4626 implements LiquidityVenue {
  kind = "transform" as const;
  private underlying: Record<Address, Address> = {};

  async supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address) {
    if (src === dst) return false;
    if (this.underlying[src] !== undefined) {
      return this.underlying[src] !== zeroAddress;
    }
    try {
      const underlying = (await readContractWithRpcStats(encoder.client, "liquidity_routing", {
        address: src,
        abi: erc4626Abi,
        functionName: "asset",
      })) as Address;
      this.underlying[src] = underlying;
      return underlying !== zeroAddress;
    } catch {
      this.underlying[src] = zeroAddress;
      return false;
    }
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    const { src, dst, srcAmount } = toConvert;

    const underlying = this.underlying[src];

    if (underlying === undefined) {
      return toConvert;
    }

    try {
      const withdrawAmount = (await readContractWithRpcStats(encoder.client, "liquidity_routing", {
        address: src,
        abi: erc4626Abi,
        functionName: "previewRedeem",
        args: [srcAmount],
      })) as bigint;
      if (withdrawAmount === 0n) return toConvert;

      encoder.erc4626Redeem(src, srcAmount, encoder.address, encoder.address);
      return { src: underlying, dst, srcAmount: withdrawAmount };
    } catch (error) {
      throw new Error(
        `(ERC4626) Error previewing redeem: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
