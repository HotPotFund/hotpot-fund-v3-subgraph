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
    calDeltaFeesOfPosition,
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
 * 这里比较耗时间，会遍历基金下的所有pool和所有头寸，并更新它们的状态
 * 如果未指定LP更新位置，认为LP都没有变化，只做历史头寸的状态更新，用在定时更新基金状态处
 * 如果指定了LP更新位置，更新指定头寸和没有LP变化头寸的所有状态，如果找到其它头寸LP有变化就说明有其它同块的事件发生，就只计算累计手续费，不更新其它状态，留给后续事件处理
 * @param fundEntity
 * @param fundTokenEntity
 * @param fund
 * @param fundTokenPriceUSD
 * @param updatedPoolIndex 指定发生了LP更新的池子位置，-1表示没有
 * @param updatedPositionIndex 指定发生了LP更新的头寸位置，-1表示没有
 */
export function updateFundPools(fundEntity: Fund,
                                fundTokenEntity: Token,
                                fund: FundContract,
                                updatedPoolIndex: number,
                                updatedPositionIndex: number,
                                fundTokenPriceUSD: BigDecimal | null = null): BigDecimal {
    let deltaFees = ZERO_BD;
    if (fundTokenPriceUSD === null) fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);
    for (let poolIndex = 0; poolIndex < fundEntity.poolsLength.toI32(); poolIndex++) {
        const pool = Pool.load(fundEntity.id + "-" + poolIndex.toString()) as Pool;
        const uniV3Pool = UniV3Pool.bind(Address.fromString(pool.address.toHex()));
        const token0Entity = Token.load(pool.token0) as Token;
        const token1Entity = Token.load(pool.token1) as Token;
        const slot0 = uniV3Pool.slot0();
        const params: CalFeesParams = {
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
            const position = Position.load(fundEntity.id + "-" + poolIndex.toString() + "-" + positionIndex.toString()) as Position;
            // 历史头寸为空，
            if (position.isEmpty
                // 如果未指定头寸更新位置，认为是历史状态更新，就可以直接返回
                && (updatedPoolIndex < 0
                    // 如果指定了头寸更新位置，又不是当前这个，也不需要做什么
                    || (updatedPoolIndex != poolIndex || updatedPositionIndex != positionIndex))) continue;
            const positionOfUniV3 = uniV3Pool.positions(position.positionKey);
            const liquidity = positionOfUniV3.value0;
            const results = calDeltaFeesOfPosition(params, position, uniV3Pool, positionOfUniV3);
            deltaFees = deltaFees.plus(results.fees);
            position.feeGrowthInside0LastX128 = results.feeGrowthInside0X128;
            position.feeGrowthInside1LastX128 = results.feeGrowthInside1X128;
            // 如果当前头寸LP有变法
            if (liquidity.notEqual(position.liquidity)
                // 但又不是指定的头寸，那应该是同一个块的其它事件造成的，就留个后面那个事件去处理
                && updatedPoolIndex >= 0 && (updatedPoolIndex != poolIndex || updatedPositionIndex != positionIndex)) {
                // 还是允许计算之前的累计手续费
                position.save();
                continue;
            }
            position.liquidity = liquidity;
            position.isEmpty = liquidity.le(ZERO_BI);
            position.assetAmount = convertTokenToDecimal(fund.assetsOfPosition(BigInt.fromI32(poolIndex), BigInt.fromI32(positionIndex)), fundTokenEntity.decimals);
            position.assetAmountUSD = position.assetAmount.times(fundTokenPriceUSD);
            position.assetShare = fundEntity.totalAssets.gt(ZERO_BD) ? position.assetAmount.div(fundEntity.totalAssets) : ZERO_BD;
            const uniV3Position = calUniV3Position(params, position, positionOfUniV3);
            const sumUSDValue = uniV3Position.amountUSD.plus(uniV3Position.feesUSD);
            const proportionOfFees = sumUSDValue.gt(ZERO_BD) ? uniV3Position.feesUSD.div(sumUSDValue) : ZERO_BD;
            position.fees = position.assetAmount.times(proportionOfFees);
            position.feesUSD = position.assetAmountUSD.times(proportionOfFees);
            position.fees0 = uniV3Position.fees0;
            position.fees1 = uniV3Position.fees1;
            position.amount = position.assetAmount.minus(position.fees);
            position.amountUSD = position.assetAmountUSD.minus(position.feesUSD);
            position.amount0 = uniV3Position.amount0;
            position.amount1 = uniV3Position.amount1;
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
                                   triggeredByInvestmentAction: boolean = true): BigDecimal {
    // 基金本币余额
    if (triggeredByInvestmentAction) fundEntity.balance = convertTokenToDecimal(ERC20.bind(Address.fromString(fundEntity.fundToken)).balanceOf(fund._address), fundTokenEntity.decimals);
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
                           updatedPoolIndex: number,
                           updatedPositionIndex: number,
                           fundTokenPriceUSD: BigDecimal | null = null,
                           isSaveSummary: boolean = true,
                           fundSummary: FundSummary | null = null): void {
    fundTokenPriceUSD = syncFundStatusData(fundEntity, fundTokenEntity, fund, fundTokenPriceUSD, updatedPoolIndex >= 0);
    let manager = Manager.load(fundEntity.manager) as Manager;

    let deltaFees = updateFundPools(fundEntity, fundTokenEntity, fund, updatedPoolIndex, updatedPositionIndex, fundTokenPriceUSD);
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
    if (block.gasUsed == ZERO_BI) return;
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
        updateFees(block, fundEntity, fundTokenEntity, fund, -1, -1, null, false, fundSummary);
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
