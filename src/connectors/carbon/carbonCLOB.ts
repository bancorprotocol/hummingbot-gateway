import Decimal from 'decimal.js-light';
import { ChainCache, initSyncedCache } from '@bancor/carbon-sdk/chain-cache';
import {
  ContractsApi,
  ContractsConfig,
} from '@bancor/carbon-sdk/contracts-api';
import { Toolkit } from '@bancor/carbon-sdk/strategy-management';
import { Strategy, TokenPair } from '@bancor/carbon-sdk';
import { parseUnits } from '@bancor/carbon-sdk/utils';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { TokenInfo } from '../../chains/ethereum/ethereum-base';
import { EVMTxBroadcaster } from '../../chains/ethereum/evm.broadcaster';

import {
  CLOBMarkets,
  ClobDeleteOrderRequest,
  ClobGetOrderRequest,
  ClobGetOrderResponse,
  ClobMarketsRequest,
  ClobOrderbookRequest,
  ClobPostOrderRequest,
  ClobTickerRequest,
} from '../../clob/clob.requests';

import {
  CLOBish,
  MarketInfo,
  NetworkSelectionRequest,
  Orderbook,
} from '../../services/common-interfaces';
import { logger } from '../../services/logger';

import { BalanceRequest } from '../../network/network.requests';

import { isETHAddress } from './carbon.utils';
import { CarbonConfig } from './carbon.config';

import {
  OrderRow,
  buildOrders,
  decodeStrategyId,
  emptyToken,
  getMiddleRate,
  getStep,
} from './carbon.utils';

export class CarbonCLOB implements CLOBish {
  public parsedMarkets: MarketInfo = [];
  public carbonContractConfig: Required<ContractsConfig>;
  public carbonSDK!: Toolkit; // will be initialized in init()
  public sdkCache!: ChainCache; // will be initialized in init()
  public api: ContractsApi;
  private static _instances: { [name: string]: CarbonCLOB };
  private _chain: Ethereum;
  private _ready: boolean = false;
  private _conf: CarbonConfig.NetworkConfig;
  private _nativeToken: TokenInfo;

  private constructor(chain: string, network: string) {
    if (chain === 'ethereum') {
      this._chain = Ethereum.getInstance(network);
    } else {
      throw new Error('unsupported chain');
    }

    this._nativeToken =
      chain === 'ethereum'
        ? {
            chainId: 1,
            address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
            name: 'Ethereum',
            symbol: 'ETH',
            decimals: 18,
          }
        : emptyToken;

    this._conf = CarbonConfig.config;
    this.carbonContractConfig = this._conf.carbonContractsConfig(
      chain,
      network
    );

    this.api = new ContractsApi(
      this._chain.provider,
      this.carbonContractConfig
    );
  }

  public static getInstance(chain: string, network: string): CarbonCLOB {
    if (CarbonCLOB._instances === undefined) {
      CarbonCLOB._instances = {};
    }

    const key = `${chain}:${network}`;
    if (!(key in CarbonCLOB._instances)) {
      CarbonCLOB._instances[key] = new CarbonCLOB(chain, network);
    }

    return CarbonCLOB._instances[key];
  }
  public async loadMarkets() {
    const contractPairs = await this.api.reader.pairs();

    await Promise.all(
      contractPairs.map(async (pair) => await this._updateMarkets(pair))
    );
  }

  public async init() {
    if (!this._chain.ready() || Object.keys(this.parsedMarkets).length === 0) {
      logger.info('Initialising chain...');
      await this._chain.init();
    }

    if (!this._ready) {
      const { cache, startDataSync } = initSyncedCache(this.api.reader);
      this.sdkCache = cache;

      const decimalsMap = new Map();
      this._chain.storedTokenList.forEach((token) => {
        decimalsMap.set(token.address, token.decimals);
      });

      this.carbonSDK = new Toolkit(this.api, this.sdkCache, (address) =>
        decimalsMap.get(address.toLowerCase())
      );

      logger.info('Starting Data Sync...');
      await startDataSync();

      logger.info('Loading markets...');
      await this.loadMarkets();

      this._ready = true;
    }
  }

  public ready(): boolean {
    return this._ready;
  }

  public async markets(
    req: ClobMarketsRequest
  ): Promise<{ markets: MarketInfo }> {
    if (req.market) {
      if (req.market in this.parsedMarkets)
        return { markets: this.parsedMarkets[req.market] };

      const reversedMarket = req.market.split('-').reverse().join('-');
      if (reversedMarket in this.parsedMarkets)
        return { markets: this.parsedMarkets[reversedMarket] };
    }

    return { markets: Object.values(this.parsedMarkets) };
  }

  public async ticker(
    req: ClobTickerRequest
  ): Promise<{ markets: CLOBMarkets }> {
    return await this.markets(req);
  }

  public async orders(
    req: ClobGetOrderRequest
  ): Promise<{ orders: ClobGetOrderResponse['orders'] }> {
    if (!req.address) throw Error('Missing wallet address');

    const userStrategy = await this._findUserStrategy(req.address, req.orderId);

    if (userStrategy) {
      const [pairId, id] = decodeStrategyId(userStrategy.id);
      return {
        orders: [
          {
            id,
            pairId,
            baseToken: userStrategy.baseToken,
            quoteToken: userStrategy.quoteToken,
            buyPriceLow: userStrategy.buyPriceLow,
            buyPriceMarginal: userStrategy.buyPriceMarginal,
            buyPriceHigh: userStrategy.buyPriceHigh,
            buyBudget: userStrategy.buyBudget,
            sellPriceLow: userStrategy.sellPriceLow,
            sellPriceMarginal: userStrategy.sellPriceMarginal,
            sellPriceHigh: userStrategy.sellPriceHigh,
            sellBudget: userStrategy.sellBudget,
          },
        ],
      };
    } else {
      return {
        orders: [],
      };
    }
  }

  public async postOrder(
    req: ClobPostOrderRequest
  ): Promise<{ txHash: string }> {
    this._isMarketValid(req.market);

    const tokens = this._getTokensBySymbol(req.market.split('-'));

    const [baseAddress, quoteAddress] =
      req.side === 'BUY'
        ? [tokens[0].address, tokens[1].address]
        : [tokens[1].address, tokens[0].address];

    if (req.orderType === 'LIMIT_MAKER') {
      const createTransaction = await this.carbonSDK.createBuySellStrategy(
        baseAddress,
        quoteAddress,
        req.price,
        req.price,
        req.price,
        req.amount,
        '0',
        '0',
        '0',
        '0'
      );

      const wallet = await this._chain.getWallet(req.address);

      const txResponse = await EVMTxBroadcaster.getInstance(
        this._chain,
        wallet.address
      ).broadcast(createTransaction);

      return { txHash: txResponse.hash };
    }

    return { txHash: '' };
  }

  public async deleteOrder(
    req: ClobDeleteOrderRequest
  ): Promise<{ txHash: string }> {
    // Find user strategy wth the requested orderId
    const userStrategy = await this._findUserStrategy(req.address, req.orderId);
    if (!userStrategy) throw Error('Order does not exist.');

    const deleteTransaction = await this.carbonSDK.deleteStrategy(
      userStrategy.id
    );

    const wallet = await this._chain.getWallet(req.address);
    const txResponse = await EVMTxBroadcaster.getInstance(
      this._chain,
      wallet.address
    ).broadcast(deleteTransaction);

    return { txHash: txResponse.hash };
  }

  public estimateGas(_req: NetworkSelectionRequest): {
    gasPrice: number;
    gasPriceToken: string;
    gasLimit: number;
    gasCost: number;
  } {
    return {
      gasPrice: this._chain.gasPrice,
      gasPriceToken: this._chain.nativeTokenSymbol,
      gasLimit: this._conf.gasLimitEstimate,
      gasCost: this._chain.gasPrice * this._conf.gasLimitEstimate,
    };
  }

  public async balances(req: BalanceRequest): Promise<Record<string, any>> {
    const tokens = this._getTokensBySymbol(req.tokenSymbols);

    const userStrategies = await this.carbonSDK.getUserStrategies(req.address);

    const formattedBalances: Record<string, any> = { available: {}, total: {} };

    await Promise.all(
      tokens.map((token) => {
        const userStrategiesBuyBudgetRaw = userStrategies.filter(
          (strategy) => strategy.baseToken === token.address
        );
        const userStrategyBuyBudget = userStrategiesBuyBudgetRaw.reduce(
          (acc, strategy) => {
            return acc.add(
              new Decimal(strategy?.sellBudget || 0).div(
                new Decimal(10).pow(token.decimals)
              )
            );
          },
          new Decimal(0)
        );

        const userStrategiesSellBudgetRaw = userStrategies.filter(
          (strategy) => strategy.quoteToken === token.address
        );
        const userStrategySellBudget = userStrategiesSellBudgetRaw.reduce(
          (acc, strategy) => {
            return acc.add(
              new Decimal(strategy?.buyBudget || 0).div(
                new Decimal(10).pow(token.decimals)
              )
            );
          },
          new Decimal(0)
        );

        const userTokenBalance = userStrategyBuyBudget
          .add(userStrategySellBudget)
          .toString();

        formattedBalances.available[token.symbol] = parseUnits(
          userTokenBalance,
          token.decimals
        ).toString();
        formattedBalances.total[token.symbol] = parseUnits(
          userTokenBalance,
          token.decimals
        ).toString();
      })
    );

    return formattedBalances;
  }

  public async orderBook(req: ClobOrderbookRequest): Promise<Orderbook> {
    this._isMarketValid(req.market);

    const [base, quote] = this._getTokensBySymbol(req.market.split('-'));

    if (!base || !quote) throw Error('Invalid tokens');

    const { buyHasLiq, buyStartRate, sellHasLiq, sellStartRate, step, steps } =
      await this._getOrderbookParams(base, quote);

    const buy = buyHasLiq
      ? await this._buildOrderBook(
          true,
          base.address,
          quote.address,
          buyStartRate,
          step,
          steps
        )
      : [];

    const sell = sellHasLiq
      ? await this._buildOrderBook(
          false,
          quote.address,
          base.address,
          sellStartRate,
          step,
          steps
        )
      : [];

    const buyOrders = buildOrders(buy, base.decimals, quote.decimals);
    const sellOrders = buildOrders(sell, base.decimals, quote.decimals);

    return {
      buys: buyOrders.map((buyOrder) => {
        return {
          price: buyOrder.rate,
          quantity: buyOrder.amount,
          timestamp: Date.now(),
        };
      }),
      sells: sellOrders.map((sellOrder) => {
        return {
          price: sellOrder.rate,
          quantity: sellOrder.amount,
          timestamp: Date.now(),
        };
      }),
    };
  }

  // Helper functions

  private async _isMarketValid(market: string) {
    const symbols: MarketInfo =
      this.parsedMarkets[market] ||
      this.parsedMarkets[market.split('-').reverse().join('-')];

    if (!symbols || symbols.length < 2) throw Error('Invalid market');
  }

  private async _updateMarkets(pair: TokenPair) {
    const baseToken = this._findTokenByAddress(pair[0]);
    const quoteToken = this._findTokenByAddress(pair[1]);

    if (!baseToken || !quoteToken) return;

    const ticker =
      baseToken.symbol.toUpperCase() + '-' + quoteToken.symbol.toUpperCase();

    // will handle cache miss if no pair in cache
    const makerFee = await this.sdkCache.getTradingFeePPMByPair(
      pair[0],
      pair[1]
    );

    const market = {
      ticker,
      baseToken,
      quoteToken,
      makerFee,
    };

    this.parsedMarkets[market.ticker] = market;
  }

  private _getTokensBySymbol(symbols: string[]) {
    return symbols.map((symbol) => {
      if (symbol == 'ETH') return this._nativeToken;
      return this._chain.getTokenBySymbol(symbol) || emptyToken;
    });
  }

  private async _getOrderbookParams(base: TokenInfo, quote: TokenInfo) {
    const steps = 100;
    const ONE = new Decimal(1);

    const buyHasLiq = await this.carbonSDK.hasLiquidityByPair(
      base.address,
      quote.address
    );
    const sellHasLiq = await this.carbonSDK.hasLiquidityByPair(
      quote.address,
      base.address
    );

    const minBuy = new Decimal(
      buyHasLiq
        ? await this.carbonSDK.getMinRateByPair(base.address, quote.address)
        : 0
    );
    const maxBuy = new Decimal(
      buyHasLiq
        ? await this.carbonSDK.getMaxRateByPair(base.address, quote.address)
        : 0
    );
    const minSell = new Decimal(
      sellHasLiq
        ? await this.carbonSDK.getMinRateByPair(quote.address, base.address)
        : 0
    );
    const maxSell = new Decimal(
      sellHasLiq
        ? await this.carbonSDK.getMaxRateByPair(quote.address, base.address)
        : 0
    );

    const minSellNormalized = sellHasLiq ? ONE.div(maxSell) : new Decimal(0);
    const maxSellNormalized = sellHasLiq ? ONE.div(minSell) : new Decimal(0);

    const deltaBuy = maxBuy.minus(minBuy);
    const deltaSell = maxSellNormalized.minus(minSellNormalized);

    const stepBuy = deltaBuy.div(steps);
    const stepSell = deltaSell.div(steps);

    const step = getStep(
      stepBuy,
      stepSell,
      minBuy,
      maxBuy,
      steps,
      minSell,
      maxSell
    );

    const middleRate = getMiddleRate(maxBuy, maxSell);

    const hasOverlappingRates = maxBuy.gt(minSellNormalized);
    const buyStartRate = hasOverlappingRates ? middleRate : maxBuy;
    const sellStartRate = hasOverlappingRates ? middleRate : minSellNormalized;

    return { buyHasLiq, buyStartRate, sellHasLiq, sellStartRate, step, steps };
  }

  private async _buildOrderBook(
    buy: boolean,
    baseToken: string,
    quoteToken: string,
    startRate: Decimal,
    step: Decimal,
    steps: number
  ): Promise<OrderRow[]> {
    const orders: OrderRow[] = [];
    const rates: string[] = [];
    const ONE = new Decimal(1);

    for (let i = 0; i <= steps + 1; i++) {
      const incrementBy = step.times(i);
      let rate = startRate[buy ? 'minus' : 'plus'](incrementBy);
      rate = buy ? rate : ONE.div(rate);
      if (rate.gt(0)) {
        rates.push(rate.toString());
      }
    }

    const results = await this.carbonSDK.getRateLiquidityDepthsByPair(
      baseToken,
      quoteToken,
      rates
    );

    results.forEach((liquidity, i) => {
      const length = orders.length;
      let rate = rates[i];
      let liquidityBn = new Decimal(liquidity);
      let totalBn = liquidityBn;

      if (liquidityBn.eq(0)) {
        console.warn('order book getRateLiquidityDepthsByPair returns 0');
        return;
      }
      if (buy) {
        if (length === 0) {
          liquidityBn = liquidityBn.div(rate);
        } else {
          if (liquidityBn.eq(orders[length - 1].originalTotal || '0')) {
            liquidityBn = new Decimal(orders[length - 1].amount);
          } else {
            const firstRate = new Decimal(orders[0].rate);
            const firstTotal = new Decimal(orders[0].originalTotal || '0');
            const delta = liquidityBn.minus(firstTotal);
            liquidityBn = firstTotal.div(firstRate).plus(delta.div(rate));
          }
        }
      } else {
        rate = ONE.div(rate).toString();
        totalBn = totalBn.times(rate);
      }
      orders.push({
        rate,
        total: totalBn.toString(),
        amount: liquidityBn.toString(),
        originalTotal: liquidity,
      });
    });

    return orders;
  }

  private async _findUserStrategy(
    address: string,
    orderId: string
  ): Promise<Strategy | undefined> {
    const userStrategies = await this.carbonSDK.getUserStrategies(address);

    const userStrategy = userStrategies.find((strategy) => {
      const [, strategyIndex] = decodeStrategyId(strategy.id);
      return strategyIndex === orderId;
    });
    return userStrategy;
  }

  private _findTokenByAddress(address: string): TokenInfo {
    if (isETHAddress(address)) {
      return this._nativeToken;
    } else {
      return (
        this._chain.storedTokenList.find(
          (token) => token.address === address
        ) || emptyToken
      );
    }
  }
}
