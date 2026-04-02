import type { ChainConfig } from "@morpho-blue-liquidation-bot/config";
import { base } from "viem/chains";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createWalletClientMock,
  httpMock,
  watchBlocksMock,
  privateKeyToAccountMock,
  liquidatonBotRunMock,
} = vi.hoisted(() => ({
  createWalletClientMock: vi.fn(),
  httpMock: vi.fn((url: string) => ({ url })),
  watchBlocksMock: vi.fn(),
  privateKeyToAccountMock: vi.fn(() => ({
    address: "0x0000000000000000000000000000000000000002",
  })),
  liquidatonBotRunMock: vi.fn(),
}));

let lastBotInputs: unknown;

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

vi.mock("viem/actions", async () => {
  const actual = await vi.importActual<typeof import("viem/actions")>("viem/actions");
  return {
    ...actual,
    watchBlocks: watchBlocksMock,
  };
});

vi.mock("../../src/bot.js", () => ({
  LiquidationBot: class {
    constructor(inputs: unknown) {
      lastBotInputs = inputs;
    }

    run = liquidatonBotRunMock;
  },
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
    useFlashbots: false,
    blockInterval: 1,
    watchBlocksRetryDelayMs: 5000,
    dataProvider: "morphoApi",
    executorAddress: "0x0000000000000000000000000000000000000004",
    liquidationPrivateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
    ...overrides,
  };
}

describe("launchBot simulation client", () => {
  beforeEach(() => {
    lastBotInputs = undefined;
    createWalletClientMock.mockReset();
    httpMock.mockClear();
    watchBlocksMock.mockReset();
    privateKeyToAccountMock.mockClear();
    liquidatonBotRunMock.mockReset();

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

  it("creates a separate simulation client when simulationRpcUrl is configured", async () => {
    await launchBot(createConfig(), {} as never);

    expect(httpMock).toHaveBeenNthCalledWith(1, "https://main-rpc.example");
    expect(httpMock).toHaveBeenNthCalledWith(2, "https://simulation-rpc.example");
    expect(createWalletClientMock).toHaveBeenCalledTimes(2);
    expect((lastBotInputs as { client: object; simulationClient: object }).client).not.toBe(
      (lastBotInputs as { client: object; simulationClient: object }).simulationClient,
    );
  });

  it("falls back to the main RPC when simulationRpcUrl is unset", async () => {
    await launchBot(createConfig({ simulationRpcUrl: undefined }), {} as never);

    expect(httpMock).toHaveBeenNthCalledWith(1, "https://main-rpc.example");
    expect(httpMock).toHaveBeenNthCalledWith(2, "https://main-rpc.example");
    expect(createWalletClientMock).toHaveBeenCalledTimes(2);
  });
});
