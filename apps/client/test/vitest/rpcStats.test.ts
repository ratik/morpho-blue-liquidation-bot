import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readContractMock } = vi.hoisted(() => ({
  readContractMock: vi.fn(),
}));

vi.mock("viem/actions", async () => {
  const actual = await vi.importActual<typeof import("viem/actions")>("viem/actions");
  return {
    ...actual,
    readContract: readContractMock,
  };
});

import { readContractWithRpcStats } from "../../src/rpcActions.js";
import {
  registerRpcStatsCollector,
  RpcStatsCollector,
  startRpcStatsReportingLoop,
} from "../../src/rpcStats.js";

describe("rpc stats", () => {
  beforeEach(() => {
    readContractMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collector records totals and failures via wrapped read calls", async () => {
    const collector = new RpcStatsCollector();
    registerRpcStatsCollector(8453, collector);

    readContractMock.mockResolvedValueOnce(1n).mockRejectedValueOnce(new Error("boom"));

    const client = { chain: { id: 8453 } } as Parameters<typeof readContractWithRpcStats>[0];

    await readContractWithRpcStats(client, "market_seed", {
      address: "0x0000000000000000000000000000000000000001",
      abi: [],
      functionName: "foo",
    } as never);

    await expect(
      readContractWithRpcStats(client, "market_seed", {
        address: "0x0000000000000000000000000000000000000001",
        abi: [],
        functionName: "foo",
      } as never),
    ).rejects.toThrow("boom");

    expect(collector.snapshotAndReset()).toEqual({
      market_seed: { total: 2, failed: 1 },
    });
  });

  it("emits one log line per minute and resets the window", async () => {
    const collector = new RpcStatsCollector();
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };

    collector.record("tx_simulation", false);
    collector.record("tx_simulation", true);

    startRpcStatsReportingLoop({
      chainId: 8453,
      chainName: "Base",
      logger,
      collector,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(logger.info).toHaveBeenCalledWith(
      {
        chainId: 8453,
        chainName: "Base",
        windowSeconds: 60,
        stats: {
          tx_simulation: { total: 2, failed: 1 },
        },
      },
      "RPC request stats",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
