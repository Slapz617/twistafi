import dotenv from 'dotenv';
dotenv.config();
import _ from 'lodash';

/* eslint-disable no-console */
import { Provider, StaticJsonRpcProvider } from '@ethersproject/providers';
import {
  IParaSwapSDK,
  LocalParaswapSDK,
} from '../src/implementations/local-paraswap-sdk';
import { TenderlySimulator, StateOverride } from './tenderly-simulation';
import {
  SwapSide,
  ETHER_ADDRESS,
  Network,
  ContractMethod,
  NULL_ADDRESS,
} from '../src/constants';
import {
  OptimalRate,
  TxObject,
  Address,
  Token,
  TransferFeeParams,
  Config,
} from '../src/types';
import { generateConfig } from '../src/config';
import {
  DummyDexHelper,
  DummyLimitOrderProvider,
  IDexHelper,
} from '../src/dex-helper';
import {
  AddressOrSymbol,
  constructSimpleSDK,
  SimpleFetchSDK,
} from '@paraswap/sdk';
import { OptimalRoute, ParaSwapVersion } from '@paraswap/core';
import axios from 'axios';
import { Holders, Tokens } from './constants-e2e';
import { sleep } from './utils';
import { assert } from 'ts-essentials';
import { GenericSwapTransactionBuilder } from '../src/generic-swap-transaction-builder';
import { DexAdapterService, PricingHelper } from '../src';
import { v4 as uuid } from 'uuid';

export const testingEndpoint = process.env.E2E_TEST_ENDPOINT;

class APIParaswapSDK implements IParaSwapSDK {
  paraSwap: SimpleFetchSDK;
  dexKeys: string[];
  dexHelper: IDexHelper;
  pricingHelper: PricingHelper;
  transactionBuilder: GenericSwapTransactionBuilder;
  dexAdapterService: DexAdapterService;

  constructor(
    protected network: number,
    dexKeys: string | string[],
    rpcUrl?: string,
  ) {
    this.dexKeys = Array.isArray(dexKeys) ? dexKeys : [dexKeys];
    this.paraSwap = constructSimpleSDK({
      version: ParaSwapVersion.V6,
      chainId: network,
      axios,
      apiURL: testingEndpoint,
    });
    this.dexHelper = new DummyDexHelper(this.network, rpcUrl);

    this.dexAdapterService = new DexAdapterService(
      this.dexHelper,
      this.network,
    );
    this.transactionBuilder = new GenericSwapTransactionBuilder(
      this.dexAdapterService,
    );
    this.pricingHelper = new PricingHelper(
      this.dexAdapterService,
      this.dexHelper.getLogger,
    );
  }

  async initializePricing() {
    const blockNumber = await this.dexHelper.web3Provider.eth.getBlockNumber();
    await this.pricingHelper.initialize(blockNumber, this.dexKeys);
  }

  async getPrices(
    from: Token,
    to: Token,
    amount: bigint,
    side: SwapSide,
    // contractMethod: ContractMethod,
    contractMethod: any,
    _poolIdentifiers?: { [key: string]: string[] | null } | null,
    transferFees?: TransferFeeParams,
    forceRoute?: AddressOrSymbol[],
  ): Promise<OptimalRate> {
    if (_poolIdentifiers)
      throw new Error('PoolIdentifiers is not supported by the API');

    let priceRoute;
    if (forceRoute && forceRoute.length > 0) {
      const options = {
        route: forceRoute,
        amount: amount.toString(),
        side,
        srcDecimals: from.decimals,
        destDecimals: to.decimals,
        options: {
          includeDEXS: this.dexKeys,
          includeContractMethods: [contractMethod],
          partner: 'any',
          maxImpact: 100,
        },
        ...transferFees,
      };
      priceRoute = await this.paraSwap.swap.getRateByRoute(options);
    } else {
      const options = {
        srcToken: from.address,
        destToken: to.address,
        side,
        amount: amount.toString(),
        options: {
          includeDEXS: this.dexKeys,
          includeContractMethods: [contractMethod],
          partner: 'any',
          maxImpact: 100,
        },
        ...transferFees,
        srcDecimals: from.decimals,
        destDecimals: to.decimals,
      };
      priceRoute = await this.paraSwap.swap.getRate(options);
    }

    return priceRoute as OptimalRate;
  }

  async buildTransaction(
    priceRoute: OptimalRate,
    _minMaxAmount: BigInt,
    userAddress: Address,
  ): Promise<TxObject> {
    const minMaxAmount = _minMaxAmount.toString();
    let deadline = Number((Math.floor(Date.now() / 1000) + 10 * 60).toFixed());

    return (await this.transactionBuilder.build({
      priceRoute,
      minMaxAmount: minMaxAmount.toString(),
      userAddress,
      partnerAddress: NULL_ADDRESS,
      partnerFeePercent: '0',
      deadline: deadline.toString(),
      uuid: uuid(),
    })) as TxObject;
  }

  async releaseResources(): Promise<void> {
    await this.pricingHelper.releaseResources(this.dexKeys);
  }
}

export async function testE2E(
  srcToken: Token,
  destToken: Token,
  senderAddress: Address,
  _amount: string,
  swapSide = SwapSide.SELL,
  dexKeys: string | string[],
  contractMethod: ContractMethod,
  network: Network = Network.MAINNET,
  _0: Provider,
  poolIdentifiers?: { [key: string]: string[] | null } | null,
  limitOrderProvider?: DummyLimitOrderProvider,
  transferFees?: TransferFeeParams,
  // Specified in BPS: part of 10000
  slippage?: number,
  sleepMs?: number,
  // could be used for networks without tenderly support (e.g. zkEVM)
  replaceTenderlyWithEstimateGas?: boolean,
  forceRoute?: AddressOrSymbol[],
) {
  const useAPI = testingEndpoint && !poolIdentifiers;
  // The API currently doesn't allow for specifying poolIdentifiers
  const sdk: IParaSwapSDK = useAPI
    ? new APIParaswapSDK(network, dexKeys, '')
    : new LocalParaswapSDK(network, dexKeys, '', limitOrderProvider);
  // initialize pricing
  await sdk.initializePricing?.();
  // if sleepMs is provided, pause simulation for specified time
  if (sleepMs) {
    await sleep(sleepMs);
  }
  // fetch the route
  const amount = BigInt(_amount);
  const priceRoute = await sdk.getPrices(
    srcToken,
    destToken,
    amount,
    swapSide,
    contractMethod,
    poolIdentifiers,
    transferFees,
    forceRoute,
  );
  // log the route for visibility
  console.log('Price Route:', JSON.stringify(priceRoute, null, 2));
  // prepare state overrides
  const tenderlySimulator = TenderlySimulator.getInstance();
  // any address works
  const userAddress = TenderlySimulator.DEFAULT_OWNER;
  // init `StateOverride` object
  const stateOverride: StateOverride = {};
  // fund x2 just in case
  const amountToFund = BigInt(priceRoute.srcAmount) * 2n;
  // add overrides for src token
  if (srcToken.address.toLowerCase() === ETHER_ADDRESS) {
    // add eth balance to user
    tenderlySimulator.addBalanceOverride(
      stateOverride,
      userAddress,
      amountToFund,
    );
  } else {
    // add token balance and allowance to Augustus
    await tenderlySimulator.addTokenBalanceOverride(
      stateOverride,
      network,
      srcToken.address,
      userAddress,
      amountToFund,
    );
    await tenderlySimulator.addAllowanceOverride(
      stateOverride,
      network,
      srcToken.address,
      userAddress,
      priceRoute.contractAddress,
      amountToFund,
    );
  }
  // build swap transaction
  const _slippage = slippage !== undefined ? BigInt(slippage) : 100n;
  const minMaxAmount =
    (swapSide === SwapSide.SELL
      ? BigInt(priceRoute.destAmount) * (10000n - _slippage)
      : BigInt(priceRoute.srcAmount) * (10000n + _slippage)) / 10000n;
  const swapParams = await sdk.buildTransaction(
    priceRoute,
    minMaxAmount,
    userAddress,
  );
  assert(
    swapParams.to !== undefined,
    'Transaction params missing `to` property',
  );
  // assemble `SimulationRequest`
  const { from, to, data, value } = swapParams;
  const simulationRequest = {
    chainId: network,
    from,
    to,
    data,
    value,
    blockNumber: priceRoute.blockNumber,
    stateOverride,
  };
  // simulate the transaction with overrides
  const simulation = await tenderlySimulator.simulateTransaction(
    simulationRequest,
  );
  // log gas estimation if testing against API
  if (useAPI) {
    const estimatedGas = Number(priceRoute.gasCost);
    const gasUsed = simulation.gas_used;
    console.log(
      `Gas Estimate API: ${
        priceRoute.gasCost
      }, Simulated: ${gasUsed}, Difference: ${estimatedGas - gasUsed}`,
    );
  }
  // release
  if (sdk.releaseResources) {
    await sdk.releaseResources();
  }
  // assert simulation status
  expect(simulation.status).toEqual(true);
}

const extractAllDexsFromRoute = (bestRoute: OptimalRoute[]) => {
  return _.flattenDeep(
    bestRoute.map(r =>
      r.swaps.map(s => s.swapExchanges.map(se => se.exchange)),
    ),
  );
};

export async function testPriceRoute(priceRoute: OptimalRate) {
  const slippage = 100n;
  const { network, srcToken, destToken, side } = priceRoute;
  const dexKeys = extractAllDexsFromRoute(priceRoute.bestRoute);
  console.log('Dexes: ', dexKeys.join(', '));
  const sdk: IParaSwapSDK = new APIParaswapSDK(network, dexKeys, '');
  if (sdk instanceof APIParaswapSDK) {
    // initialize as some of the dexs need states to build transaction (e.g. balancer-v2)
    await sdk?.initializePricing();
  }
  // log the route for visibility
  console.log('Price Route:', JSON.stringify(priceRoute, null, 2));
  // prepare state overrides
  const tenderlySimulator = TenderlySimulator.getInstance();
  // any address works
  const userAddress = TenderlySimulator.DEFAULT_OWNER;
  // init `StateOverride` object
  const stateOverride: StateOverride = {};
  // fund x2 just in case
  const amountToFund = BigInt(priceRoute.srcAmount) * 2n;
  // add overrides for src token
  if (srcToken.toLowerCase() === ETHER_ADDRESS) {
    // add eth balance to user
    tenderlySimulator.addBalanceOverride(
      stateOverride,
      userAddress,
      amountToFund,
    );
  } else {
    // add token balance and allowance to Augustus
    await tenderlySimulator.addTokenBalanceOverride(
      stateOverride,
      network,
      srcToken,
      userAddress,
      amountToFund,
    );
    await tenderlySimulator.addAllowanceOverride(
      stateOverride,
      network,
      srcToken,
      userAddress,
      priceRoute.contractAddress,
      amountToFund,
    );
  }
  // build swap transaction
  const minMaxAmount =
    (side === SwapSide.SELL
      ? BigInt(priceRoute.destAmount) * (10000n - slippage)
      : BigInt(priceRoute.srcAmount) * (10000n + slippage)) / 10000n;
  const swapParams = await sdk.buildTransaction(
    priceRoute,
    minMaxAmount,
    userAddress,
  );
  assert(
    swapParams.to !== undefined,
    'Transaction params missing `to` property',
  );
  // assemble `SimulationRequest`
  const { from, to, data, value } = swapParams;
  const simulationRequest = {
    chainId: network,
    from,
    to,
    data,
    value,
    blockNumber: priceRoute.blockNumber,
    stateOverride,
  };
  // simulate the transaction with overrides
  const simulation = await tenderlySimulator.simulateTransaction(
    simulationRequest,
  );
  // release
  if (sdk.releaseResources) {
    await sdk.releaseResources();
  }
  // assert simulation status
  expect(simulation.status).toEqual(true);
}

export type TestParamE2E = {
  config: Config;
  srcToken: Token;
  destToken: Token;
  senderAddress: Address;
  thirdPartyAddress?: Address;
  _amount: string;
  swapSide: SwapSide;
  dexKeys: string | string[];
  contractMethod: ContractMethod;
  network: Network;
  poolIdentifiers?: { [key: string]: string[] | null } | null;
  limitOrderProvider?: DummyLimitOrderProvider;
  transferFees?: TransferFeeParams;
  sleepMs?: number;
  skipTenderly?: boolean;
};

export async function newTestE2E({
  config,
  srcToken,
  destToken,
  senderAddress,
  thirdPartyAddress,
  _amount,
  swapSide,
  dexKeys,
  contractMethod,
  network,
  poolIdentifiers,
  limitOrderProvider,
  transferFees,
  sleepMs,
  skipTenderly,
}: TestParamE2E) {
  const useTenderly = !skipTenderly;
  const sdk = new LocalParaswapSDK(network, dexKeys, '', limitOrderProvider);
  // initialize pricing
  await sdk.initializePricing?.();
  // if sleepMs is provided, pause simulation for specified time
  if (sleepMs) {
    await sleep(sleepMs);
  }
  // fetch the route
  const amount = BigInt(_amount);
  const priceRoute = await sdk.getPrices(
    srcToken,
    destToken,
    amount,
    swapSide,
    contractMethod,
    poolIdentifiers,
    transferFees,
  );
  // log the route for visibility
  console.log('Price Route:', JSON.stringify(priceRoute, null, 2));
  // exit function if not using tenderly
  if (!useTenderly) {
    console.log('Skipping transaction simulation on Tenderly');
    if (sdk.releaseResources) {
      await sdk.releaseResources();
    }
    return;
  }
  // prepare state overrides
  const tenderlySimulator = TenderlySimulator.getInstance();
  // any address works
  const userAddress = TenderlySimulator.DEFAULT_OWNER;
  // init `StateOverride` object
  const stateOverride: StateOverride = {};
  // fund x2 just in case
  const amountToFund = BigInt(priceRoute.srcAmount) * 2n;
  // add overrides for src token
  if (srcToken.address.toLowerCase() === ETHER_ADDRESS) {
    // add eth balance to user
    tenderlySimulator.addBalanceOverride(
      stateOverride,
      userAddress,
      amountToFund,
    );
  } else {
    // add token balance and allowance to Augustus
    await tenderlySimulator.addTokenBalanceOverride(
      stateOverride,
      network,
      srcToken.address,
      userAddress,
      amountToFund,
    );
    await tenderlySimulator.addAllowanceOverride(
      stateOverride,
      network,
      srcToken.address,
      userAddress,
      priceRoute.contractAddress,
      amountToFund,
    );
  }
  // build swap transaction
  const _slippage = 700n;
  const minMaxAmount =
    (swapSide === SwapSide.SELL
      ? BigInt(priceRoute.destAmount) * (10000n - _slippage)
      : BigInt(priceRoute.srcAmount) * (10000n + _slippage)) / 10000n;
  const swapParams = await sdk.buildTransaction(
    priceRoute,
    minMaxAmount,
    userAddress,
  );
  assert(
    swapParams.to !== undefined,
    'Transaction params missing `to` property',
  );
  if (useTenderly) {
    // assemble `SimulationRequest`
    const { from, to, data, value } = swapParams;
    const simulationRequest = {
      chainId: network,
      from,
      to,
      data,
      value,
      blockNumber: priceRoute.blockNumber,
      stateOverride,
    };
    // simulate the transaction with overrides
    const simulation = await tenderlySimulator.simulateTransaction(
      simulationRequest,
    );
    // log gas estimation
    const estimatedGas = Number(priceRoute.gasCost);
    const gasUsed = simulation.gas_used;
    console.log(
      `Gas Estimate API: ${
        priceRoute.gasCost
      }, Simulated: ${gasUsed}, Difference: ${estimatedGas - gasUsed}`,
    );
    // release
    await sdk.releaseResources?.();
    // assert simulation status
    expect(simulation.status).toEqual(true);
  }
}

export const getEnv = (envName: string, optional: boolean = false): string => {
  if (!process.env[envName]) {
    if (optional) {
      return '';
    }
    throw new Error(`Missing ${envName}`);
  }

  return process.env[envName]!;
};

type Pairs = { name: string; sellAmount: string; buyAmount: string }[][];
type DexToPair = Record<string, Pairs>;

export const constructE2ETests = (
  testSuiteName: string,
  network: Network,
  testDataset: DexToPair,
) => {
  const sideToContractMethods = new Map([
    [
      SwapSide.SELL,
      [
        ContractMethod.simpleSwap,
        ContractMethod.multiSwap,
        ContractMethod.megaSwap,
      ],
    ],
    [SwapSide.BUY, [ContractMethod.simpleBuy, ContractMethod.buy]],
  ]);

  describe(testSuiteName, () => {
    const tokens = Tokens[network];
    const holders = Holders[network];
    const provider = new StaticJsonRpcProvider(
      generateConfig(network).privateHttpProvider,
      network,
    );

    Object.entries(testDataset).forEach(([dexKey, pairs]) => {
      describe(dexKey, () => {
        sideToContractMethods.forEach((contractMethods, side) =>
          describe(`${side}`, () => {
            contractMethods.forEach((contractMethod: ContractMethod) => {
              pairs.forEach(pair => {
                describe(`${contractMethod}`, () => {
                  it(`${pair[0].name} -> ${pair[1].name}`, async () => {
                    await testE2E(
                      tokens[pair[0].name],
                      tokens[pair[1].name],
                      holders[pair[0].name],
                      side === SwapSide.SELL
                        ? pair[0].sellAmount
                        : pair[0].buyAmount,
                      side,
                      dexKey,
                      contractMethod,
                      network,
                      provider,
                    );
                  });
                  it(`${pair[1].name} -> ${pair[0].name}`, async () => {
                    await testE2E(
                      tokens[pair[1].name],
                      tokens[pair[0].name],
                      holders[pair[1].name],
                      side === SwapSide.SELL
                        ? pair[1].sellAmount
                        : pair[1].buyAmount,
                      side,
                      dexKey,
                      contractMethod,
                      network,
                      provider,
                    );
                  });
                });
              });
            });
          }),
        );
      });
    });
  });
};

export const testGasEstimation = async (
  network: Network,
  srcToken: Token,
  destToken: Token,
  amount: bigint,
  swapSide: SwapSide,
  dexKeys: string | string[],
  contractMethod: ContractMethod,
  route?: string[],
  targetDifference?: number,
) => {
  assert(
    testingEndpoint,
    'Estimation can only be tested with testing endpoint',
  );
  // initialize pricing
  const sdk = new APIParaswapSDK(network, dexKeys);
  await sdk.initializePricing();
  // fetch the route
  const priceRoute = await sdk.getPrices(
    srcToken,
    destToken,
    amount,
    swapSide,
    contractMethod,
    undefined,
    undefined,
    route,
  );
  // make sure fetched route uses correct `contractMethod`
  assert(
    priceRoute.contractMethod === contractMethod,
    'Price route has incorrect contract method!',
  );
  // log the route for visibility
  console.log('Price Route:', JSON.stringify(priceRoute, null, 2));
  // prepare state overrides
  const tenderlySimulator = TenderlySimulator.getInstance();
  // any address works
  const userAddress = TenderlySimulator.DEFAULT_OWNER;
  // init `StateOverride` object
  const stateOverride: StateOverride = {};
  // fund x2 just in case
  const amountToFund = amount * 2n;
  // add overrides for src token
  if (srcToken.address.toLowerCase() === ETHER_ADDRESS) {
    // add eth balance to user
    tenderlySimulator.addBalanceOverride(
      stateOverride,
      userAddress,
      amountToFund,
    );
  } else {
    // add token balance and allowance to Augustus
    await tenderlySimulator.addTokenBalanceOverride(
      stateOverride,
      network,
      srcToken.address,
      userAddress,
      amountToFund,
    );
    await tenderlySimulator.addAllowanceOverride(
      stateOverride,
      network,
      srcToken.address,
      userAddress,
      priceRoute.tokenTransferProxy,
      amountToFund,
    );
  }
  // add overrides for dest token (dust balance)
  if (destToken.address.toLowerCase() === ETHER_ADDRESS) {
    // add eth dust
    tenderlySimulator.addBalanceOverride(stateOverride, userAddress, 1n);
  } else {
    // add token dust
    await tenderlySimulator.addTokenBalanceOverride(
      stateOverride,
      network,
      destToken.address,
      userAddress,
      1n,
    );
  }
  // build swap transaction
  const slippage = 100n;
  const minMaxAmount =
    (swapSide === SwapSide.SELL
      ? BigInt(priceRoute.destAmount) * (10000n - slippage)
      : BigInt(priceRoute.srcAmount) * (10000n + slippage)) / 10000n;
  const swapParams = await sdk.buildTransaction(
    priceRoute,
    minMaxAmount,
    userAddress,
  );
  assert(
    swapParams.to !== undefined,
    'Transaction params missing `to` property',
  );
  // assemble `SimulationRequest`
  const { from, to, data, value } = swapParams;
  const simulationRequest = {
    chainId: network,
    from,
    to,
    data,
    value,
    blockNumber: priceRoute.blockNumber,
    stateOverride,
  };
  // simulate the transaction with overrides
  const simulation = await tenderlySimulator.simulateTransaction(
    simulationRequest,
  );
  // compare and assert
  const estimatedGas = Number(priceRoute.gasCost);
  const actualGas = simulation.gas_used;
  const diffPercent = ((estimatedGas - actualGas) / actualGas) * 100;
  console.log(
    `Estimated gas cost: ${estimatedGas}, actual gas cost: ${actualGas}, diff: ${diffPercent}%`,
  );
  if (targetDifference !== undefined) {
    assert(
      targetDifference <= Math.abs(diffPercent),
      `Deviation is higher than target ${targetDifference}%`,
    );
  }
  // release
  await sdk.releaseResources();
};
