import type { ChainConfig } from "@morpho-blue-liquidation-bot/config";
import { base } from "viem/chains";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createWalletClientMock,
  httpMock,
  privateKeyToAccountMock,
  startRpcStatsReportingLoopMock,
  registerRpcStatsCollectorMock,
  liquidatonBotWarmupDataMock,
  liquidatonBotRunMock,
  rpcStatsCollectorMock,
} = vi.hoisted(() => ({
  createWalletClientMock: vi.fn(),
  httpMock: vi.fn((url: string) => ({ url })),
  privateKeyToAccountMock: vi.fn(() => ({
    address: "0x0000000000000000000000000000000000000002",
  })),
  startRpcStatsReportingLoopMock: vi.fn(),
  registerRpcStatsCollectorMock: vi.fn(),
  liquidatonBotWarmupDataMock: vi.fn(),
  liquidatonBotRunMock: vi.fn(),
  rpcStatsCollectorMock: vi.fn(),
}));

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createWalletClient: createWalletClientMock,
    http: httpMock,
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: privateKeyToAccountMock,
}));

vi.mock("../../src/bot.js", () => ({
  LiquidationBot: class {
    run = liquidatonBotRunMock;
    warmupData = liquidatonBotWarmupDataMock;
  },
}));

vi.mock("../../src/rpcStats.js", () => ({
  RpcStatsCollector: rpcStatsCollectorMock,
  registerRpcStatsCollector: registerRpcStatsCollectorMock,
  startRpcStatsReportingLoop: startRpcStatsReportingLoopMock,
}));

import { launchBot } from "../../src/index.js";

function createConfig(overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chain: base,
    chainId: base.id,
    rpcUrl: "https://main-rpc.example",
    simulationRpcUrl: "https://simulation-rpc.example",
    wNative: "0x4200000000000000000000000000000000000006",
    vaultWhitelist: ["0x0000000000000000000000000000000000000003"],
    additionalMarketsWhitelist: [],
    liquidityVenues: [],
    pricers: undefined,
    treasuryAddress: undefined,
    liquidationBufferBps: undefined,
    pollingIntervalMs: 10_000,
    executorAddress: "0x0000000000000000000000000000000000000004",
    liquidationPrivateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
    ...overrides,
  };
}

describe("launchBot rpc stats", () => {
  beforeEach(() => {
    createWalletClientMock.mockReset();
    startRpcStatsReportingLoopMock.mockReset();
    registerRpcStatsCollectorMock.mockReset();
    liquidatonBotWarmupDataMock.mockReset();
    liquidatonBotRunMock.mockReset();
    rpcStatsCollectorMock.mockReset();

    rpcStatsCollectorMock.mockImplementation(() => ({ kind: "collector" }));
    liquidatonBotWarmupDataMock.mockResolvedValue(undefined);
    liquidatonBotRunMock.mockResolvedValue(undefined);

    createWalletClientMock
      .mockReturnValueOnce({
        account: { address: "0x0000000000000000000000000000000000000002" },
        chain: base,
      })
      .mockReturnValueOnce({
        account: { address: "0x0000000000000000000000000000000000000002" },
        chain: base,
      });
  });

  it("starts the rpc stats reporting loop during launch", async () => {
    await launchBot(createConfig(), {} as never);

    expect(registerRpcStatsCollectorMock).toHaveBeenCalledWith(base.id, { kind: "collector" });
    expect(startRpcStatsReportingLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: base.id,
        chainName: base.name,
        collector: { kind: "collector" },
      }),
    );
  });
});
