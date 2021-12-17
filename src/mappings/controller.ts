import { BigDecimal, BigInt, ethereum, log } from "@graphprotocol/graph-ts"

import {
    ChangeVerifiedToken,
    Harvest,
    SetGovernance,
    SetHarvestPath,
    SetMaxPriceImpact,
    SetMaxSqrtSlippage,
} from "../../generated/Controller/Controller";
import { ERC20 } from "../../generated/Controller/ERC20";
import { UniV3Pool } from "../../generated/Controller/UniV3Pool";
import {
    Bundle,
    Fund,
    FundSummary,
    HarvestSummary,
    HarvestTx,
    Manager,
    PathPool,
    Pool,
    Position,
    SetHarvestPathTx,
    Token,
    Transaction
} from "../../generated/schema";
import {
    BI_18,
    BLOCK_AMOUNT_PER_MINUTE,
    calFeesOfPosition,
    CalFeesParams,
    calUniV3Position,
    convertTokenToDecimal,
    exponentToBigDecimal,
    fetchTokenBalanceOf,
    fetchTokenDecimals,
    fetchTokenName,
    fetchTokenSymbol,
    fetchTokenTotalSupply,
    getTokenPriceUSD,
    ONE_BI,
    START_PROCESS_BLOCK, syncTxStatusData,
    uniV3Factory,
    WETH_ADDRESS,
    ZERO_BD,
    ZERO_BI
} from "../helpers";
import { Address } from "@graphprotocol/graph-ts/index";
import { Fund as FundContract } from "../../generated/templates/Fund/Fund";
import { updateFundDayData } from "./dayUpdates";


/**
 * 这里比较耗时间，会变量基金下的所有pool和所有头寸，并更新它们的状态
 * @param fundEntity
 * @param fundTokenEntity
 * @param fund
 * @param fundTokenPriceUSD
 * @param isCheckEmptyPosition
 */
export function updateFundPools(fundEntity: Fund,
                                fundTokenEntity: Token,
                                fund: FundContract,
                                fundTokenPriceUSD: BigDecimal | null = null,
                                isCheckEmptyPosition: boolean = true): BigDecimal {
    let deltaFees = ZERO_BD;
    if (fundTokenPriceUSD === null) fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);
    for (let poolIndex = 0; poolIndex < fundEntity.poolsLength.toI32(); poolIndex++) {
        let pool = Pool.load(fundEntity.id + "-" + poolIndex.toString()) as Pool;
        let uniV3Pool = UniV3Pool.bind(Address.fromString(pool.address.toHex()));
        let token0Entity = Token.load(pool.token0) as Token;
        let token1Entity = Token.load(pool.token1) as Token;
        let slot0 = uniV3Pool.slot0();
        let params: CalFeesParams = {
            sqrtPriceX96: slot0.value0,
            tickCurrent: slot0.value1,
            feeGrowthGlobal0X128: uniV3Pool.feeGrowthGlobal0X128(),
            feeGrowthGlobal1X128: uniV3Pool.feeGrowthGlobal1X128(),
            fundTokenPriceUSD,
            token0PriceUSD: ZERO_BD,
            token1PriceUSD: ZERO_BD,
            decimals0: token0Entity.decimals,
            decimals1: token1Entity.decimals,
        };
        if (fundTokenEntity.id == token0Entity.id)
            params.token0PriceUSD = params.fundTokenPriceUSD;
        else
            params.token0PriceUSD = getTokenPriceUSD(token0Entity);

        if (fundTokenEntity.id == token1Entity.id)
            params.token1PriceUSD = params.fundTokenPriceUSD;
        else
            params.token1PriceUSD = getTokenPriceUSD(token1Entity);

        for (let positionIndex = 0; positionIndex < pool.positionsLength.toI32(); positionIndex++) {
            let position = Position.load(fundEntity.id + "-" + poolIndex.toString() + "-" + positionIndex.toString()) as Position;
            if (position.isEmpty && !isCheckEmptyPosition) continue;
            let positionOfUniV3 = uniV3Pool.positions(position.positionKey);
            let liquidity = positionOfUniV3.value0;
            // 如果当前头寸和历史状态都为空，就直接返回
            if (liquidity.equals(ZERO_BI) && position.isEmpty) continue;
            let results = calFeesOfPosition(params, position, uniV3Pool, positionOfUniV3);
            deltaFees = deltaFees.plus(results.fees);
            position.liquidity = liquidity;
            position.isEmpty = !position.liquidity.gt(ZERO_BI);
            position.feeGrowthInside0LastX128 = results.feeGrowthInside0X128;
            position.feeGrowthInside1LastX128 = results.feeGrowthInside1X128;
            position.assetAmount = convertTokenToDecimal(fund.assetsOfPosition(BigInt.fromI32(poolIndex), BigInt.fromI32(positionIndex)), fundTokenEntity.decimals);
            position.assetAmountUSD = position.assetAmount.times(fundTokenPriceUSD);
            position.assetShare = fundEntity.totalAssets.gt(ZERO_BD) ? position.assetAmount.div(fundEntity.totalAssets) : ZERO_BD;
            let uniV3Position = calUniV3Position(params, position, positionOfUniV3);
            position.amount = uniV3Position.amount;
            position.amountUSD = uniV3Position.amountUSD;
            position.amount0 = uniV3Position.amount0;
            position.amount1 = uniV3Position.amount1;
            position.fees = uniV3Position.fees;
            position.feesUSD = uniV3Position.feesUSD;
            position.fees0 = uniV3Position.fees0;
            position.fees1 = uniV3Position.fees1;
            position.save();
        }

        pool.assetAmount = convertTokenToDecimal(fund.assetsOfPool(BigInt.fromI32(poolIndex)), fundTokenEntity.decimals);
        pool.assetAmountUSD = pool.assetAmount.times(fundTokenPriceUSD);
        pool.assetShare = fundEntity.totalAssets.gt(ZERO_BD) ? pool.assetAmount.div(fundEntity.totalAssets) : ZERO_BD;
        pool.save();
    }

    return deltaFees;
}

export function syncFundStatusData(fundEntity: Fund,
                                   fundTokenEntity: Token,
                                   fund: FundContract,
                                   fundTokenPriceUSD: BigDecimal | null = null,
                                   isSyncFT: boolean = true): BigDecimal {
    // 基金本币余额
    if (isSyncFT) fundEntity.balance = convertTokenToDecimal(ERC20.bind(Address.fromString(fundEntity.fundToken)).balanceOf(fund._address), fundTokenEntity.decimals);
    fundEntity.totalAssets = convertTokenToDecimal(fund.totalAssets(), fundTokenEntity.decimals);
    if (fundTokenPriceUSD === null) fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);
    fundEntity.totalAssetsUSD = fundTokenPriceUSD.times(fundEntity.totalAssets);
    return fundTokenPriceUSD;
}


//这个应该是第一个会调用的方法，因为要添加Token才能使用
export function handleChangeVerifiedToken(event: ChangeVerifiedToken): void {
    let address = event.params.token;
    let token = Token.load(address.toHex());

    if (token === null) {
        token = new Token(address.toHex());
        token.symbol = fetchTokenSymbol(address);
        token.name = fetchTokenName(address);
        token.totalSupply = fetchTokenTotalSupply(address);
        let decimals = fetchTokenDecimals(address);
        // bail if we couldn't figure out the decimals
        if (decimals === null) {
            log.debug('mybug the decimal on token 0 was null', []);
            decimals = BI_18;//默认设为18位精度
        }
        token.decimals = decimals;
    }
    token.isVerified = event.params.isVerified;
    token.fundIncome = convertTokenToDecimal(fetchTokenBalanceOf(address, event.address), token.decimals);

    token.save();
}

export function handleHarvest(event: Harvest): void {
    let txId = event.transaction.hash.toHex();
    let transaction = (Transaction.load(txId) || new Transaction(txId)) as Transaction;
    let txHarvests = (transaction.harvests || []) as Array<string>;
    let id = txId + "-" + BigInt.fromI32(txHarvests.length).toString();
    transaction.harvests = txHarvests.concat([id]);
    syncTxStatusData(transaction, event);

    let tokenEntity = Token.load(event.params.token.toHex()) as Token;
    tokenEntity.fundIncome = convertTokenToDecimal(fetchTokenBalanceOf(event.params.token, event.address), tokenEntity.decimals);

    let harvestTx = (HarvestTx.load(id) || new HarvestTx(id)) as HarvestTx;
    harvestTx.transaction = txId;
    harvestTx.token = tokenEntity.id;
    harvestTx.amount = convertTokenToDecimal(event.params.amount, tokenEntity.decimals);
    harvestTx.burned = convertTokenToDecimal(event.params.burned, BI_18);
    harvestTx.amountUSD = getTokenPriceUSD(tokenEntity).times(harvestTx.amount);

    let harvestSummary = HarvestSummary.load("1");
    if (harvestSummary === null) {
        harvestSummary = new HarvestSummary("1");
        harvestSummary.txCount = ONE_BI;
        harvestSummary.totalBurned = ZERO_BD;
        harvestSummary.totalAmountUSD = ZERO_BD;
    }
    harvestSummary.txCount = harvestSummary.txCount.plus(ONE_BI);
    harvestSummary.totalBurned = harvestSummary.totalBurned.plus(harvestTx.burned);
    harvestSummary.totalAmountUSD = harvestSummary.totalAmountUSD.plus(harvestTx.amountUSD);

    tokenEntity.save();
    harvestTx.save();
    transaction.save();
    harvestSummary.save();
}

export function handleSetHarvestPath(event: SetHarvestPath): void {
    let address = event.params.token;
    let token = Token.load(address.toHex());
    if (token === null) {
        token = new Token(address.toHex());
        token.symbol = fetchTokenSymbol(address);
        token.name = fetchTokenName(address);
        token.totalSupply = fetchTokenTotalSupply(address);
        token.isVerified = false;
        let decimals = fetchTokenDecimals(address);
        // bail if we couldn't figure out the decimals
        if (decimals === null) {
            log.debug('mybug the decimal on token 0 was null', []);
            decimals = BI_18;//默认设为18位精度
        }
        token.decimals = decimals;
    }
    token.fundIncome = convertTokenToDecimal(fetchTokenBalanceOf(address, event.address), token.decimals);

    let txId = event.transaction.hash.toHex();
    let transaction = (Transaction.load(txId) || new Transaction(txId)) as Transaction;
    let txSetHarvestPaths = (transaction.setHarvestPaths || []) as Array<string>;
    let id = txId + "-" + BigInt.fromI32(txSetHarvestPaths.length).toString();
    transaction.setHarvestPaths = txSetHarvestPaths.concat([id]);
    syncTxStatusData(transaction, event);
    token.setHarvestPathTx = id;
    token.save();

    let setPathTx = new SetHarvestPathTx(id);
    setPathTx.transaction = txId;
    setPathTx.distToken = event.params.token.toHex();
    setPathTx.path = event.params.path;

    let pathPools = (setPathTx.pathPools || []) as Array<string>;
    pathPools.splice(0, pathPools.length);
    let count = 0;
    let data = event.params.path.toHex().substr(2);
    do {
        let pathPoolId = event.address.toHex() + "-" + event.params.token.toHex() + count.toString();
        let pathPool = (PathPool.load(pathPoolId) || new PathPool(pathPoolId)) as PathPool;
        pathPool.tokenIn = '0x' + data.substr(0, 40);
        // @ts-ignore
        pathPool.fee = parseInt('0x' + data.substr(40, 6)) as i32;
        pathPool.tokenOut = '0x' + data.substr(46, 40);
        pathPool.address = uniV3Factory.getPool(Address.fromString(pathPool.tokenIn), Address.fromString(pathPool.tokenOut), pathPool.fee);
        pathPool.save();
        pathPools.push(pathPoolId);
        count += 1;
        data = data.substr(count * 46);
    } while (data.length >= 86);
    setPathTx.pathPools = pathPools;

    setPathTx.save();
    transaction.save();
}

export function handleSetGovernance(event: SetGovernance): void {

}

export function handleSetMaxSqrtSlippage(event: SetMaxSqrtSlippage): void {

}

export function handleSetMaxPriceImpact(event: SetMaxPriceImpact): void {

}

export function updateFees(block: ethereum.Block,
                    fundEntity: Fund,
                    fundTokenEntity: Token,
                    fund: FundContract,
                    fundTokenPriceUSD: BigDecimal | null = null,
                    isSaveSummary: boolean = true,
                    fundSummary: FundSummary | null = null,
                    isSyncAll: boolean = true): void {
    fundTokenPriceUSD = syncFundStatusData(fundEntity, fundTokenEntity, fund, fundTokenPriceUSD, isSyncAll);
    let manager = Manager.load(fundEntity.manager) as Manager;

    let deltaFees = updateFundPools(fundEntity, fundTokenEntity, fund, fundTokenPriceUSD, isSyncAll);
    let totalShare = convertTokenToDecimal(fundEntity.totalSupply, fundEntity.decimals);
    let sharePrice = totalShare.gt(ZERO_BD) ? deltaFees.div(totalShare) : ZERO_BD;

    fundEntity.lastedSettlementPrice = fundEntity.lastedSettlementPrice.plus(sharePrice);
    fundEntity.totalFees = fundEntity.totalFees.plus(deltaFees);
    fundEntity.totalPendingFees = fundEntity.totalPendingFees.plus(deltaFees);
    manager.totalFees = manager.totalFees.plus(deltaFees);
    manager.totalPendingFees = manager.totalPendingFees.plus(deltaFees);
    updateFundDayData(block, fundEntity, totalShare);

    if (fundSummary != null || isSaveSummary) {
        fundSummary = (fundSummary || FundSummary.load("1")) as FundSummary;
        fundSummary.totalFees = fundSummary.totalFees.plus(deltaFees);
        fundSummary.totalPendingFees = fundSummary.totalPendingFees.plus(deltaFees);
    }
    if (fundSummary != null && isSaveSummary) {
        fundSummary.save();
    } else {
        let bundle = Bundle.load("1");
        if (bundle === null) bundle = new Bundle("1");
        bundle.ethPriceUSD = getTokenPriceUSD(Token.load(WETH_ADDRESS));
        bundle.timestamp = block.timestamp;
        bundle.save();
    }
    manager.save();
}

export function handleBlock(block: ethereum.Block): void {
    let bundle: Bundle | null;
    let DayDuration = BigInt.fromI32(86400);
    let fiveMinute = BigInt.fromI32(86100);// 剩余5分钟的时间点
    // 如果当前时间是当日的最后5分钟内: 86400 - 86100 = 300
    if (block.timestamp.mod(DayDuration).gt(fiveMinute)) {
        bundle = Bundle.load("1");
        // 之前已经在5分钟内更新过了, 就不用再更新了
        if (bundle != null && bundle.timestamp.mod(DayDuration).gt(fiveMinute)) return;
    } else {
        //old data 60*60s处理一次
        if (block.number.lt(BigInt.fromI32(START_PROCESS_BLOCK)) && block.number.mod(BigInt.fromI32(60 * BLOCK_AMOUNT_PER_MINUTE))
            .notEqual(ZERO_BI)) return;
        //For performance, every 5*5 blocks are processed for about 5*60s
        if (block.number.mod(BigInt.fromI32(5 * BLOCK_AMOUNT_PER_MINUTE)).notEqual(ZERO_BI)) return;
    }

    let fundSummary = FundSummary.load("1");
    if (fundSummary === null) return;
    let funds = fundSummary.funds;
    if (funds === null) return;

    let totalAssetsUSD = ZERO_BD;
    for (let i = 0; i < funds.length; i++) {
        let fundEntity = Fund.load(funds[i]) as Fund;
        let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
        let fund = FundContract.bind(Address.fromString(funds[i]));
        updateFees(block, fundEntity, fundTokenEntity, fund, null, false, fundSummary, false);
        totalAssetsUSD = totalAssetsUSD.plus(fundEntity.totalAssetsUSD);
        fundEntity.save();
    }
    bundle = (bundle || new Bundle("1")) as Bundle;
    bundle.ethPriceUSD = getTokenPriceUSD(Token.load(WETH_ADDRESS));
    bundle.timestamp = block.timestamp;
    bundle.save();
    fundSummary.totalAssetsUSD = totalAssetsUSD;
    fundSummary.save();
}
