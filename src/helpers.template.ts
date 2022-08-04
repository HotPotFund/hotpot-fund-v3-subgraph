/* eslint-disable prefer-const */
import {Address, BigDecimal, BigInt, Bytes} from '@graphprotocol/graph-ts'
import { Position, Token, Transaction } from "../generated/schema";

import {UniV3Factory} from "../generated/Controller/UniV3Factory";
import {UniV3Pool, UniV3Pool__positionsResult} from "../generated/Controller/UniV3Pool";
import {ERC20} from "../generated/Controller/ERC20";
import {ERC20SymbolBytes} from "../generated/Controller/ERC20SymbolBytes";
import {ERC20NameBytes} from "../generated/Controller/ERC20NameBytes";
import { ByteArray, crypto, ethereum } from "@graphprotocol/graph-ts/index";

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';

export let ZERO_BI = BigInt.fromI32(0);
export let ONE_BI = BigInt.fromI32(1);
export let ZERO_BD = BigDecimal.fromString('0');
export let ONE_BD = BigDecimal.fromString('1');
export let BI_18 = BigInt.fromI32(18);
export let BI_6 = BigInt.fromI32(6);
export let BI_256_MAX = BigInt.fromI32(1).leftShift(255).minus(ONE_BI).leftShift(1).plus(ONE_BI);

export let START_PROCESS_BLOCK = {{startProcessBlock}};
export let BLOCK_AMOUNT_PER_MINUTE = {{blockAmountPerMinute}};
export const HPT_ADDRESS = '{{hptAddress}}';
export const WETH_ADDRESS = '{{wethAddress}}';
const USDC_WETH_03_POOL = '{{usdcEth03Pool}}';

// token where amounts should contribute to tracked volume and liquidity
export let STABLE_TOKENS: string[] = [
    '{{daiAddress}}', // DAI
    '{{usdcAddress}}', // USDC
    '{{usdtAddress}}', // USDT
];

export const UNI_V3_FACTORY_ADDRESS = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
export let uniV3Factory = UniV3Factory.bind(Address.fromString(UNI_V3_FACTORY_ADDRESS));

export let FixedPoint_Q128_BD = BigInt.fromI32(2).pow(128).toBigDecimal();
export let FixedPoint_Q128_BI = BigInt.fromI32(2).pow(128);
export let FixedPoint_Q96_BD = BigInt.fromI32(2).pow(96).toBigDecimal();
export let FixedPoint_Q96_BI = BigInt.fromI32(2).pow(96);

export function syncTxStatusData(txEntity: Transaction, event: ethereum.Event): void {
    txEntity.timestamp = event.block.timestamp;
    txEntity.blockNumber = event.block.number;
    txEntity.from = event.transaction.from;
    txEntity.gasPrice = event.transaction.gasPrice.divDecimal(exponentToBigDecimal(BI_18));
    txEntity.gasLimit = event.transaction.gasLimit;
    txEntity.gasFee = txEntity.gasPrice.times(txEntity.gasLimit.toBigDecimal());
}

function getEthPriceInUSD(): BigDecimal {
    // fetch eth prices for each stablecoin
    let usdcPool = UniV3Pool.bind(Address.fromString(USDC_WETH_03_POOL));
    let result = usdcPool.try_slot0();
    let USDC_ADDRESS = STABLE_TOKENS[1];
    if (!result.reverted) {
        let sqrtPrice = (result.value.value0).toBigDecimal().div(FixedPoint_Q96_BD);
        let decimals0 = WETH_ADDRESS > USDC_ADDRESS ? BI_6 : BI_18;
        let decimals1 = WETH_ADDRESS > USDC_ADDRESS ? BI_18 : BI_6;
        let price0 = sqrtPrice.times(sqrtPrice)//最小单位的token1/token0比值 1wei token0对应多少wei token1
            .times(exponentToBigDecimal(decimals0))//先扩大到 1Unit token0 对应多少wei token1
            .div(exponentToBigDecimal(decimals1));//再转换成 1Unit token0 对应多少Unit token1
        return WETH_ADDRESS > USDC_ADDRESS ? ONE_BD.div(price0) : price0;
    }
    else return ZERO_BD;
}

export function getAvailableUniV3Pool(tokenA: Address, tokenB: Address): Address {
    let poolAddr = uniV3Factory.getPool(tokenA, tokenB, 500);
    if (poolAddr.toHex() == ADDRESS_ZERO)
        poolAddr = uniV3Factory.getPool(tokenA, tokenB, 3000);
    if (poolAddr.toHex() == ADDRESS_ZERO)
        poolAddr = uniV3Factory.getPool(tokenA, tokenB, 10000);
    return poolAddr;
}

export function getTokenPriceUSD(tokenEntity: Token | null): BigDecimal {
    if (tokenEntity == null) return ZERO_BD;

    let ethUsdPrice = getEthPriceInUSD();
    if (tokenEntity.id == WETH_ADDRESS) return ethUsdPrice;

    let largestUSDLiquidity = ZERO_BD;
    let priceSoFar = ZERO_BD;
    let ethPoolAddr = getAvailableUniV3Pool(Address.fromString(tokenEntity.id), Address.fromString(WETH_ADDRESS));
    if (ethPoolAddr.toHex() != ADDRESS_ZERO) {
        let weth9 = ERC20.bind(Address.fromString(WETH_ADDRESS));
        largestUSDLiquidity = convertTokenToDecimal(weth9.balanceOf(ethPoolAddr), BI_18).times(ethUsdPrice);

        let uniV3Pool = UniV3Pool.bind(ethPoolAddr);
        let sqrtPrice0: BigDecimal = ZERO_BD;
        let result = uniV3Pool.try_slot0();
        if (!result.reverted) sqrtPrice0 = (result.value.value0).toBigDecimal().div(FixedPoint_Q96_BD);
        let price0 = sqrtPrice0.times(sqrtPrice0);

        if (tokenEntity.id < WETH_ADDRESS) {
            price0 = price0.times(exponentToBigDecimal(tokenEntity.decimals)).div(exponentToBigDecimal(BI_18));
            priceSoFar = price0.times(ethUsdPrice);
        } else {
            price0 = price0.times(exponentToBigDecimal(BI_18)).div(exponentToBigDecimal(tokenEntity.decimals));
            priceSoFar = price0.notEqual(ZERO_BD) ? ONE_BD.div(price0).times(ethUsdPrice) : ZERO_BD;
        }
    }

    for (let i = 0; i < STABLE_TOKENS.length; i++) {
        if (tokenEntity.id == STABLE_TOKENS[i]) return ONE_BD;

        let poolAddress = getAvailableUniV3Pool(Address.fromString(tokenEntity.id), Address.fromString(STABLE_TOKENS[i]));
        if (poolAddress.toHex() == ADDRESS_ZERO) continue;

        let uniV3Pool = UniV3Pool.bind(poolAddress);
        let sqrtPrice0: BigDecimal = ZERO_BD;
        let result = uniV3Pool.try_slot0();
        if (!result.reverted) sqrtPrice0 = (result.value.value0).toBigDecimal().div(FixedPoint_Q96_BD);
        let price0 = sqrtPrice0.times(sqrtPrice0);

        let stableCoin = ERC20.bind(Address.fromString(STABLE_TOKENS[i]));
        let stableCoinDecimals = BigInt.fromI32(stableCoin.decimals());
        if (tokenEntity.id < STABLE_TOKENS[i]) {
            price0 = price0.times(exponentToBigDecimal(tokenEntity.decimals)).div(exponentToBigDecimal(stableCoinDecimals));
        } else {
            price0 = price0.times(exponentToBigDecimal(stableCoinDecimals)).div(exponentToBigDecimal(tokenEntity.decimals));
            price0 = price0.notEqual(ZERO_BD) ? ONE_BD.div(price0) : ZERO_BD;
        }

        let liquidity = convertTokenToDecimal(stableCoin.balanceOf(poolAddress), stableCoinDecimals);
        if (largestUSDLiquidity.lt(liquidity)) {
            largestUSDLiquidity = liquidity;
            priceSoFar = price0;
        }
    }

    return priceSoFar;
}

export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
    let bd = BigDecimal.fromString('1');
    for (let i = ZERO_BI; i.lt(decimals); i = i.plus(ONE_BI)) {
        bd = bd.times(BigDecimal.fromString('10'))
    }
    return bd;
}

export function convertTokenToDecimal(tokenAmount: BigInt, exchangeDecimals: BigInt): BigDecimal {
    if (exchangeDecimals == ZERO_BI) {
        return tokenAmount.toBigDecimal()
    }
    return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
}

export function equalToZero(value: BigDecimal): boolean {
    const formattedVal = parseFloat(value.toString());
    const zero = parseFloat(ZERO_BD.toString());
    return zero == formattedVal;
}

export function isNullEthValue(value: string): boolean {
    return value == '0x0000000000000000000000000000000000000000000000000000000000000001'
}

export function fetchTokenSymbol(tokenAddress: Address): string {
    let contract = ERC20.bind(tokenAddress);
    let contractSymbolBytes = ERC20SymbolBytes.bind(tokenAddress);

    // try types string and bytes32 for symbol
    let symbolValue = 'unknown';
    let symbolResult = contract.try_symbol();
    if (symbolResult.reverted) {
        let symbolResultBytes = contractSymbolBytes.try_symbol();
        if (!symbolResultBytes.reverted) {
            // for broken pairs that have no symbol function exposed
            if (!isNullEthValue(symbolResultBytes.value.toHexString())) {
                symbolValue = symbolResultBytes.value.toString()
            }
        }
    } else {
        symbolValue = symbolResult.value
    }

    return symbolValue
}

export function fetchTokenName(tokenAddress: Address): string {
    let contract = ERC20.bind(tokenAddress);
    let contractNameBytes = ERC20NameBytes.bind(tokenAddress);

    // try types string and bytes32 for name
    let nameValue = 'unknown';
    let nameResult = contract.try_name();
    if (nameResult.reverted) {
        let nameResultBytes = contractNameBytes.try_name();
        if (!nameResultBytes.reverted) {
            // for broken exchanges that have no name function exposed
            if (!isNullEthValue(nameResultBytes.value.toHexString())) {
                nameValue = nameResultBytes.value.toString()
            }
        }
    } else {
        nameValue = nameResult.value
    }

    return nameValue
}

export function fetchTokenTotalSupply(tokenAddress: Address): BigInt {
    let contract = ERC20.bind(tokenAddress);
    let totalSupplyValue = ZERO_BI;
    let totalSupplyResult = contract.try_totalSupply();
    if (!totalSupplyResult.reverted) {
        totalSupplyValue = totalSupplyResult.value
    }
    return totalSupplyValue;
}

export function fetchTokenBalanceOf(tokenAddress: Address, owner: Address): BigInt {
    let contract = ERC20.bind(tokenAddress);
    let balanceValue = ZERO_BI;
    let balanceValueResult = contract.try_balanceOf(owner);
    if (!balanceValueResult.reverted) {
        balanceValue = balanceValueResult.value
    }
    return balanceValue;
}

export function fetchTokenDecimals(tokenAddress: Address): BigInt {
    let contract = ERC20.bind(tokenAddress);
    // try types uint8 for decimals
    let decimalValue = 0;// 默认精度为0
    let decimalResult = contract.try_decimals();
    if (!decimalResult.reverted) {
        decimalValue = decimalResult.value
    }

    return BigInt.fromI32(decimalValue)
}

export function getPositionKey(pool: string, tickLower: BigInt, tickUpper: BigInt): Bytes {
    let packedMsg = pool
        + tickLower.bitAnd(BigInt.fromI32(0xffffff)).toHex().substr(2).padStart(6, "0")
        + tickUpper.bitAnd(BigInt.fromI32(0xffffff)).toHex().substr(2).padStart(6, "0");
    return Bytes.fromHexString(crypto.keccak256(ByteArray.fromHexString(packedMsg)).toHex()) as Bytes;
}

class FeeGrowthInsideParams {
    pool: UniV3Pool;
    // @ts-ignore
    tickLower: i32;
    // @ts-ignore
    tickUpper: i32;
    // @ts-ignore
    tickCurrent: i32;
    feeGrowthGlobal0X128: BigInt;
    feeGrowthGlobal1X128: BigInt;
}

class FeeGrowthInsides {
    feeGrowthInside0X128: BigInt;
    feeGrowthInside1X128: BigInt;
    isFail: boolean;
}

export function getFeeGrowthInside(params: FeeGrowthInsideParams): FeeGrowthInsides {
    let feeGrowthInside0X128: BigInt = ZERO_BI;
    let feeGrowthInside1X128: BigInt = ZERO_BI;

    // calculate fee growth below
    let ticksResult = params.pool.try_ticks(params.tickLower);
    if (ticksResult.reverted) {
        return {feeGrowthInside0X128, feeGrowthInside1X128, isFail: true} as FeeGrowthInsides;
    }
    let lower = ticksResult.value;
    let feeGrowthBelow0X128: BigInt;
    let feeGrowthBelow1X128: BigInt;
    if (params.tickCurrent >= params.tickLower) {
        feeGrowthBelow0X128 = lower.value2;
        feeGrowthBelow1X128 = lower.value3;
    } else {
        feeGrowthBelow0X128 = params.feeGrowthGlobal0X128.minus(lower.value2);
        feeGrowthBelow1X128 = params.feeGrowthGlobal1X128.minus(lower.value3);
    }

    // calculate fee growth above
    ticksResult = params.pool.try_ticks(params.tickUpper);
    if (ticksResult.reverted) {
        return {feeGrowthInside0X128, feeGrowthInside1X128, isFail: true} as FeeGrowthInsides;
    }
    let upper = ticksResult.value;
    let feeGrowthAbove0X128: BigInt;
    let feeGrowthAbove1X128: BigInt;
    if (params.tickCurrent < params.tickUpper) {
        feeGrowthAbove0X128 = upper.value2;
        feeGrowthAbove1X128 = upper.value3;
    } else {
        feeGrowthAbove0X128 = params.feeGrowthGlobal0X128.minus(upper.value2);
        feeGrowthAbove1X128 = params.feeGrowthGlobal1X128.minus(upper.value3);
    }

    feeGrowthInside0X128 = params.feeGrowthGlobal0X128.minus(feeGrowthBelow0X128).minus(feeGrowthAbove0X128);
    feeGrowthInside1X128 = params.feeGrowthGlobal1X128.minus(feeGrowthBelow1X128).minus(feeGrowthAbove1X128);
    if (feeGrowthInside0X128.lt(ZERO_BI)) {
        feeGrowthInside0X128 = BI_256_MAX.plus(feeGrowthInside0X128).plus(ONE_BI);
    }
    if (feeGrowthInside1X128.lt(ZERO_BI)) {
        feeGrowthInside1X128 = BI_256_MAX.plus(feeGrowthInside1X128).plus(ONE_BI);
    }
    return {feeGrowthInside0X128, feeGrowthInside1X128, isFail: false} as FeeGrowthInsides;
}

export class CalFeesParams {
    sqrtPriceX96: BigInt;
    // @ts-ignore
    tickCurrent: i32;
    feeGrowthGlobal0X128: BigInt;
    feeGrowthGlobal1X128: BigInt;
    fundTokenPriceUSD: BigDecimal;
    token0PriceUSD: BigDecimal;
    token1PriceUSD: BigDecimal;
    decimals0: BigInt;
    decimals1: BigInt;
}

export class FeesOfPosition {
    fees: BigDecimal;
    feeGrowthInside0X128: BigInt;
    feeGrowthInside1X128: BigInt;
    isFail: boolean;
}

export function calDeltaFeesOfPosition(params: CalFeesParams, position: Position, uniPool: UniV3Pool, uniV3Position: UniV3Pool__positionsResult): FeesOfPosition {
    let feeGrowthInside0X128 = ZERO_BI;
    let feeGrowthInside1X128 = ZERO_BI;
    if (uniV3Position.value0.equals(ZERO_BI)) {
        feeGrowthInside0X128 = uniV3Position.value1;
        feeGrowthInside1X128 = uniV3Position.value2;
    } else {
        // get global feeGrowthInside
        let feeGrowthInside = getFeeGrowthInside({
            pool: uniPool,
            tickLower: position.tickLower.toI32(),
            tickUpper: position.tickUpper.toI32(),
            tickCurrent: params.tickCurrent,
            feeGrowthGlobal0X128: params.feeGrowthGlobal0X128,
            feeGrowthGlobal1X128: params.feeGrowthGlobal1X128
        });
        if (feeGrowthInside.isFail) return {fees: ZERO_BD, feeGrowthInside0X128, feeGrowthInside1X128, isFail: true};
        feeGrowthInside0X128 = feeGrowthInside.feeGrowthInside0X128;
        feeGrowthInside1X128 = feeGrowthInside.feeGrowthInside1X128;
    }

    //如果是0，保持最新的feeGrowthInside
    if (position.feeGrowthInside0LastX128.equals(ZERO_BI)) {
        position.feeGrowthInside0LastX128 = feeGrowthInside0X128;
        position.feeGrowthInside1LastX128 = feeGrowthInside1X128;
    }
    // calculate accumulated fees
    let subVal0 = feeGrowthInside0X128.minus(position.feeGrowthInside0LastX128);
    let subVal1 = feeGrowthInside1X128.minus(position.feeGrowthInside1LastX128);
    if (subVal0.lt(ZERO_BI)) subVal0 = BI_256_MAX.plus(subVal0).plus(ONE_BI);
    if (subVal1.lt(ZERO_BI)) subVal1 = BI_256_MAX.plus(subVal1).plus(ONE_BI);
    let amount0 = convertTokenToDecimal(subVal0.times(position.liquidity).div(FixedPoint_Q128_BI), params.decimals0);
    let amount1 = convertTokenToDecimal(subVal1.times(position.liquidity).div(FixedPoint_Q128_BI), params.decimals1);

    let feesUSD = amount0.times(params.token0PriceUSD).plus(amount1.times(params.token1PriceUSD));
    // let fees = params.fundTokenPriceUSD.gt(ZERO_BD) ? feesUSD.div(params.fundTokenPriceUSD) : ZERO_BD;
    return {fees: feesUSD, feeGrowthInside0X128, feeGrowthInside1X128, isFail: false}
}

export class UniV3Position {
    fees0: BigDecimal;  //token0  fee
    fees1: BigDecimal;  //token1  fee
    fees: BigDecimal;   //fundToken fee
    feesUSD: BigDecimal;//usd fee

    amount0: BigDecimal;
    amount1: BigDecimal;
    amount: BigDecimal;
    amountUSD: BigDecimal;
}

export function calUniV3Position(params: CalFeesParams, position: Position, uniV3Position: UniV3Pool__positionsResult): UniV3Position {
    if (uniV3Position.value0.equals(ZERO_BI)) return {
        fees0: ZERO_BD, fees1: ZERO_BD, fees: ZERO_BD, feesUSD: ZERO_BD,
        amount0: ZERO_BD, amount1: ZERO_BD, amount: ZERO_BD, amountUSD: ZERO_BD
    };
    // calculate accumulated fees
    let subVal0 = position.feeGrowthInside0LastX128.minus(uniV3Position.value1);
    let subVal1 = position.feeGrowthInside1LastX128.minus(uniV3Position.value2);
    if (subVal0.lt(ZERO_BI)) subVal0 = BI_256_MAX.plus(subVal0).plus(ONE_BI);
    if (subVal1.lt(ZERO_BI)) subVal1 = BI_256_MAX.plus(subVal1).plus(ONE_BI);
    let fees0 = convertTokenToDecimal((subVal0).times(uniV3Position.value0).div(FixedPoint_Q128_BI), params.decimals0);
    let fees1 = convertTokenToDecimal((subVal1).times(uniV3Position.value0).div(FixedPoint_Q128_BI), params.decimals1);

    fees0 = fees0.plus(convertTokenToDecimal(uniV3Position.value3, params.decimals0));
    fees1 = fees1.plus(convertTokenToDecimal(uniV3Position.value4, params.decimals1));

    let feesUSD = fees0.times(params.token0PriceUSD).plus(fees1.times(params.token1PriceUSD));
    let fees = params.fundTokenPriceUSD.gt(ZERO_BD) ? feesUSD.div(params.fundTokenPriceUSD) : ZERO_BD;

    let tickLower = position.tickLower.toI32();
    let tickUpper = position.tickUpper.toI32();
    let amount0 = ZERO_BD, amount1 = ZERO_BD;
    // 计算流动性资产
    if (params.tickCurrent < tickLower) {
        // current tick is below the passed range; liquidity can only become in range by crossing from left to
        // right, when we'll need _more_ token0 (it's becoming more valuable) so user must provide it
        amount0 = convertTokenToDecimal(getAmount0Delta(
            getSqrtRatioAtTick(tickLower),
            getSqrtRatioAtTick(tickUpper),
            uniV3Position.value0,
            true
        ), params.decimals0)
    } else if (params.tickCurrent < tickUpper) {
        // current tick is inside the passed range
        amount0 = convertTokenToDecimal(getAmount0Delta(
            params.sqrtPriceX96,
            getSqrtRatioAtTick(tickUpper),
            uniV3Position.value0,
            true
        ), params.decimals0);
        amount1 = convertTokenToDecimal(getAmount1Delta(
            getSqrtRatioAtTick(tickLower),
            params.sqrtPriceX96,
            uniV3Position.value0,
            true
        ), params.decimals1);
    } else {
        // current tick is above the passed range; liquidity can only become in range by crossing from right to
        // left, when we'll need _more_ token1 (it's becoming more valuable) so user must provide it
        amount1 = convertTokenToDecimal(getAmount1Delta(
            getSqrtRatioAtTick(tickLower),
            getSqrtRatioAtTick(tickUpper),
            uniV3Position.value0,
            true
        ), params.decimals1);
    }

    let amountUSD = amount0.times(params.token0PriceUSD).plus(amount1.times(params.token1PriceUSD));
    let amount = params.fundTokenPriceUSD.gt(ZERO_BD) ? amountUSD.div(params.fundTokenPriceUSD) : ZERO_BD;

    return {fees, feesUSD, fees0, fees1, amount0, amount1, amount, amountUSD};
}

// @ts-ignore
function getSqrtRatioAtTick(tick: i32): BigInt {
    let val = 1.0001 ** tick;
    return BigInt.fromString(BigDecimal.fromString((val).toString())
        .times(BigInt.fromI32(2).pow(192).toBigDecimal()).toString()).sqrt()
}

// function getSqrtRatioAtTick(tick: i32): BigInt {
//     let absTick = tick < 0 ? -tick : tick as number;
//     let ratio = (absTick & 0x1) != 0 ? "0xfffcb933bd6fad37aa2d162d1a594001"
//         : "0x100000000000000000000000000000000";
//
//     if (absTick & 0x2 != 0) ratio = (ratio.times("0xfff97272373d413259a46990580e213a")).rightShift(128);
//     if (absTick & 0x4 != 0) ratio = (ratio.times("0xfff2e50f5f656932ef12357cf3c7fdcc")).rightShift(128);
//     if (absTick & 0x8 != 0) ratio = (ratio.times("0xffe5caca7e10e4e61c3624eaa0941cd0")).rightShift(128);
//     if (absTick & 0x10 != 0) ratio = (ratio.times("0xffcb9843d60f6159c9db58835c926644")).rightShift(128);
//     if (absTick & 0x20 != 0) ratio = (ratio.times("0xff973b41fa98c081472e6896dfb254c0")).rightShift(128);
//     if (absTick & 0x40 != 0) ratio = (ratio.times("0xff2ea16466c96a3843ec78b326b52861")).rightShift(128);
//     if (absTick & 0x80 != 0) ratio = (ratio.times("0xfe5dee046a99a2a811c461f1969c3053")).rightShift(128);
//     if (absTick & 0x100 != 0) ratio = (ratio.times("0xfcbe86c7900a88aedcffc83b479aa3a4")).rightShift(128);
//     if (absTick & 0x200 != 0) ratio = (ratio.times("0xf987a7253ac413176f2b074cf7815e54")).rightShift(128);
//     if (absTick & 0x400 != 0) ratio = (ratio.times("0xf3392b0822b70005940c7a398e4b70f3")).rightShift(128);
//     if (absTick & 0x800 != 0) ratio = (ratio.times("0xe7159475a2c29b7443b29c7fa6e889d9")).rightShift(128);
//     if (absTick & 0x1000 != 0) ratio = (ratio.times("0xd097f3bdfd2022b8845ad8f792aa5825")).rightShift(128);
//     if (absTick & 0x2000 != 0) ratio = (ratio.times("0xa9f746462d870fdf8a65dc1f90e061e5")).rightShift(128);
//     if (absTick & 0x4000 != 0) ratio = (ratio.times("0x70d869a156d2a1b890bb3df62baf32f7")).rightShift(128);
//     if (absTick & 0x8000 != 0) ratio = (ratio.times("0x31be135f97d08fd981231505542fcfa6")).rightShift(128);
//     if (absTick & 0x10000 != 0) ratio = (ratio.times("0x9aa508b5b7a84e1c677de54f3e99bc9")).rightShift(128);
//     if (absTick & 0x20000 != 0) ratio = (ratio.times("0x5d6af8dedb81196699c329225ee604")).rightShift(128);
//     if (absTick & 0x40000 != 0) ratio = (ratio.times("0x2216e584f5fa1ea926041bedfe98")).rightShift(128);
//     if (absTick & 0x80000 != 0) ratio = (ratio.times("0x48a170391f7dc42444e8fa2")).rightShift(128);
//
//     if (tick > 0) ratio = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" / ratio;
//     return ("0xffffffffffffffffffffffffffffffffffffffff") & ((ratio.rightShift(32)).plus((ratio.mod(ONE_BI.leftShift(32)).equals(ZERO_BI) ? ZERO_BI : ONE_BI)));
// }

function divRoundingUp(x: BigInt, y: BigInt): BigInt {
    return x.div(y).plus(x.mod(y).gt(ZERO_BI) ? ONE_BI : ZERO_BI);
}

function mulDivRoundingUp(a: BigInt, b: BigInt, denominator: BigInt): BigInt {
    let result = a.times(b).div(denominator);
    if (a.times(b).mod(denominator).gt(ZERO_BI)) result = result.plus(ONE_BI);
    return result;
}

function getAmount0DeltaAmount(
    sqrtRatioAX96: BigInt,
    sqrtRatioBX96: BigInt,
    liquidity: BigInt,
    roundUp: boolean
): BigInt {
    if (sqrtRatioAX96.gt(sqrtRatioBX96)) {
        let temp = sqrtRatioAX96;
        sqrtRatioAX96 = sqrtRatioBX96;
        sqrtRatioBX96 = temp;
    }

    let amount0: BigInt;
    let numerator1 = liquidity.times(FixedPoint_Q96_BI);
    let numerator2 = sqrtRatioBX96.minus(sqrtRatioAX96);

    amount0 = roundUp ? divRoundingUp(numerator1.times(numerator2).div(sqrtRatioBX96), sqrtRatioAX96)
        : numerator1.times(numerator2).div(sqrtRatioBX96).div(sqrtRatioAX96);

    return amount0
}

function getAmount1DeltaAmount(
    sqrtRatioAX96: BigInt,
    sqrtRatioBX96: BigInt,
    liquidity: BigInt,
    roundUp: boolean
): BigInt {
    if (sqrtRatioAX96.gt(sqrtRatioBX96)) {
        let temp = sqrtRatioAX96;
        sqrtRatioAX96 = sqrtRatioBX96;
        sqrtRatioBX96 = temp;
    }

    return roundUp ? mulDivRoundingUp(liquidity, sqrtRatioBX96.minus(sqrtRatioAX96), FixedPoint_Q96_BI)
        : liquidity.times(sqrtRatioBX96.minus(sqrtRatioAX96)).div(FixedPoint_Q96_BI)
}

function getAmount0Delta(
    sqrtRatioAX96: BigInt,
    sqrtRatioBX96: BigInt,
    liquidity: BigInt,
    isRemoveLP: boolean
): BigInt {
    return getAmount0DeltaAmount(sqrtRatioAX96, sqrtRatioBX96, liquidity, !isRemoveLP);
}

function getAmount1Delta(
    sqrtRatioAX96: BigInt,
    sqrtRatioBX96: BigInt,
    liquidity: BigInt,
    isRemoveLP: boolean
): BigInt {
    return getAmount1DeltaAmount(sqrtRatioAX96, sqrtRatioBX96, liquidity, !isRemoveLP);
}
