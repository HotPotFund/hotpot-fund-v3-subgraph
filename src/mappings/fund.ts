import {
    AddTx,
    DepositTx,
    Fund,
    FundSummary,
    InitTx,
    Investor,
    InvestorSummary,
    Manager,
    MoveTx,
    Path,
    PathPool,
    Pool,
    Position,
    SetDeadlineTx,
    SetPathTx,
    SubTx,
    Token,
    Transaction,
    WithdrawTx
} from "../../generated/schema";
import { Address, BigDecimal, BigInt, ethereum } from "@graphprotocol/graph-ts/index";
import {
    Add,
    Deposit as DepositEvent,
    Fund as FundContract,
    Init,
    Move,
    SetDeadline, SetDescriptor,
    SetPath,
    Sub,
    Transfer,
    Withdraw as WithdrawEvent
} from "../../generated/templates/Fund/Fund";
import { syncFundStatusData, updateFees, updateFundPools } from "./controller";
import { updateFundDayData, updateInvestorDayData } from "./dayUpdates";
import {
    ADDRESS_ZERO,
    convertTokenToDecimal,
    FixedPoint_Q128_BD,
    getPositionKey,
    getTokenPriceUSD,
    HPT_ADDRESS, ONE_BD,
    ONE_BI, syncTxStatusData,
    uniV3Factory,
    ZERO_BD,
    ZERO_BI
} from "../helpers";
import { StakingRewards } from "../../generated/templates/Fund/StakingRewards";
import { UniV3Pool } from "../../generated/Controller/UniV3Pool";


function isStakingTransfer(addr: Address, fundAddr: Address): StakingRewards | null {
    let stakingRewards = StakingRewards.bind(addr);
    let result = stakingRewards.try_stakingToken();
    if (result.reverted || result.value.toHexString() != fundAddr.toHexString()) return null;

    result = stakingRewards.try_rewardsToken();
    if (result.reverted || result.value.toHexString() != HPT_ADDRESS) return null;

    return stakingRewards;
}

export function handleTransfer(event: Transfer): void {
    // 如果是mint, burn操作
    if (event.params.from.toHexString() == ADDRESS_ZERO || event.params.to.toHexString() == ADDRESS_ZERO) return;

    let fundEntity = Fund.load(event.address.toHex()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(event.address);

    let fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);
    let deltaFees = updateFundPools(fundEntity, fundTokenEntity, fund, -1, -1, fundTokenPriceUSD);
    let totalShare = convertTokenToDecimal(fundEntity.totalSupply, fundEntity.decimals);
    let sharePrice = totalShare.gt(ZERO_BD) ? deltaFees.div(totalShare) : ZERO_BD;
    let lastedSettlementPrice = fundEntity.lastedSettlementPrice.plus(sharePrice);

    //结算fromInvestor
    let fromInvestor = createInvestorEntity(event.address, event.params.from, event);
    let fromInvestorLastedShare = convertTokenToDecimal(fromInvestor.share, fundEntity.decimals);
    let withdrewShare = convertTokenToDecimal(event.params.value, fundEntity.decimals);
    let fromInvestorFees = lastedSettlementPrice.minus(fromInvestor.lastedSettlementPrice).times(fromInvestorLastedShare);
    let withdrawFees = lastedSettlementPrice.minus(fromInvestor.lastedSettlementPrice).times(withdrewShare)
        .plus(fromInvestorLastedShare.gt(ZERO_BD) ? fromInvestor.totalPendingFees.times(withdrewShare).div(fromInvestorLastedShare) : ZERO_BD);
    fromInvestor.lastedSettlementPrice = lastedSettlementPrice;
    fromInvestor.totalFees = fromInvestor.totalFees.plus(fromInvestorFees);
    fromInvestor.totalPendingFees = fromInvestor.totalPendingFees.plus(fromInvestorFees).minus(withdrawFees);
    fromInvestor.totalWithdrewFees = fromInvestor.totalFees.minus(fromInvestor.totalPendingFees);

    fromInvestor.share = fromInvestor.share.minus(event.params.value);
    //如果接收者是挖矿合约，做抵押操作
    if (isStakingTransfer(event.params.to, event.address) != null)
        fromInvestor.stakingShare = fromInvestor.stakingShare.plus(event.params.value);
    updateInvestorDayData(event, fromInvestor, fromInvestorLastedShare);

    //结算toInvestor
    let toInvestor = createInvestorEntity(event.address, event.params.to, event);
    let toInvestorLastedShare = convertTokenToDecimal(toInvestor.share, fundEntity.decimals);
    let toInvestorFees = lastedSettlementPrice.minus(toInvestor.lastedSettlementPrice).times(toInvestorLastedShare);
    toInvestor.lastedSettlementPrice = lastedSettlementPrice;
    toInvestor.totalFees = toInvestor.totalFees.plus(toInvestorFees);
    toInvestor.totalPendingFees = toInvestor.totalPendingFees.plus(toInvestorFees);

    toInvestor.share = toInvestor.share.plus(event.params.value);
    // 发起者设挖矿合约，做提取操作
    if (isStakingTransfer(event.params.from, event.address) != null)
        toInvestor.stakingShare = toInvestor.stakingShare.minus(event.params.value);
    updateInvestorDayData(event, toInvestor, toInvestorLastedShare);

    //fund fees
    fundEntity.lastedSettlementPrice = lastedSettlementPrice;
    fundEntity.totalFees = fundEntity.totalFees.plus(deltaFees);
    fundEntity.totalPendingFees = fundEntity.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    fundEntity.totalWithdrewFees = fundEntity.totalFees.minus(fundEntity.totalPendingFees);
    //fundSummary fees
    let fundSummary = FundSummary.load("1") as FundSummary;
    fundSummary.totalFees = fundSummary.totalFees.plus(deltaFees);
    fundSummary.totalPendingFees = fundSummary.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    fundSummary.totalWithdrewFees = fundSummary.totalFees.minus(fundSummary.totalPendingFees);
    //manager fees
    let manager = Manager.load(fundEntity.manager) as Manager;
    manager.totalFees = manager.totalFees.plus(deltaFees);
    manager.totalPendingFees = manager.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    manager.totalWithdrewFees = manager.totalFees.minus(manager.totalPendingFees);

    fromInvestor.save();
    toInvestor.save();
    fundEntity.save();
    fundSummary.save();
    manager.save();

    updateFundDayData(event.block, fundEntity, totalShare);
}

export function createInvestorEntity(fundAddr: Address, userAddr: Address, event: ethereum.Event): Investor {
    let ID = fundAddr.toHexString() + "-" + userAddr.toHexString();
    let investor = Investor.load(ID);

    if (investor === null) {
        investor = new Investor(ID);
        investor.summary = userAddr.toHex();
        investor.fund = fundAddr.toHexString();

        investor.share = ZERO_BI;
        investor.stakingShare = ZERO_BI;
        investor.totalInvestment = ZERO_BD;
        investor.totalInvestmentUSD = ZERO_BD;
        investor.totalDepositedAmount = ZERO_BD;
        investor.totalDepositedAmountUSD = ZERO_BD;
        investor.totalWithdrewAmount = ZERO_BD;
        investor.totalWithdrewAmountUSD = ZERO_BD;
        investor.lastDepositTime = ZERO_BI;

        investor.lastedSettlementPrice = ZERO_BD;
        investor.totalFees = ZERO_BD;
        investor.totalPendingFees = ZERO_BD;
        investor.totalWithdrewFees = ZERO_BD;
        investor.totalProtocolFees = ZERO_BD;
        investor.totalProtocolFeesUSD = ZERO_BD;

        investor.save();

        let investorSummary = InvestorSummary.load(userAddr.toHex());
        if (investorSummary === null) {
            investorSummary = new InvestorSummary(userAddr.toHex());
            investorSummary.totalInvestmentUSD = ZERO_BD;
            investorSummary.totalProtocolFeesUSD = ZERO_BD;
            investorSummary.created_timestamp = event.block.timestamp;
            investorSummary.created_block = event.block.number;
            investorSummary.save();
        }
    }

    return investor;
}

//初始化时这个是每个基金都要做的操作
export function handleDeposit(event: DepositEvent): void {
    let fundEntity = Fund.load(event.address.toHex()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(event.address);

    let txId = event.transaction.hash.toHex();
    let transaction = (Transaction.load(txId) || new Transaction(txId)) as Transaction;
    let txDeposits = (transaction.deposits || []) as Array<string>;
    let id = txId + "-" + BigInt.fromI32(txDeposits.length).toString();
    transaction.deposits = txDeposits.concat([id]);
    transaction.fund = event.address.toHex();
    syncTxStatusData(transaction, event);

    let fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);
    let depositTx = (DepositTx.load(id) || new DepositTx(id)) as DepositTx;
    depositTx.transaction = txId;
    depositTx.fund = event.address.toHexString();
    depositTx.owner = event.params.owner;
    depositTx.amount = convertTokenToDecimal(event.params.amount, fundTokenEntity.decimals);
    depositTx.amountUSD = depositTx.amount.times(fundTokenPriceUSD);
    depositTx.share = event.params.share;
    depositTx.investor = event.address.toHexString() + "-" + event.params.owner.toHexString();

    syncFundStatusData(fundEntity, fundTokenEntity, fund, fundTokenPriceUSD);
    fundEntity.totalSupply = fund.totalSupply();
    fundEntity.totalInvestment = convertTokenToDecimal(fund.totalInvestment(), fundTokenEntity.decimals);
    fundEntity.totalInvestmentUSD = fundEntity.totalInvestmentUSD.plus(depositTx.amountUSD);
    fundEntity.totalDepositedAmount = fundEntity.totalDepositedAmount.plus(depositTx.amount);
    fundEntity.totalDepositedAmountUSD = fundEntity.totalDepositedAmountUSD.plus(depositTx.amountUSD);
    // fundEntity.totalWithdrewAmount = fundEntity.totalWithdrewAmount;

    let deltaFees = updateFundPools(fundEntity, fundTokenEntity, fund, -1, -1, fundTokenPriceUSD);
    let totalShare = convertTokenToDecimal(fundEntity.totalSupply.minus(event.params.share), fundEntity.decimals);
    let sharePrice = totalShare.gt(ZERO_BD) ? deltaFees.div(totalShare) : ZERO_BD;
    let lastedSettlementPrice = fundEntity.lastedSettlementPrice.plus(sharePrice);

    let investor = createInvestorEntity(event.address, event.params.owner, event);
    let investorSummary = InvestorSummary.load(event.params.owner.toHex()) as InvestorSummary;
    let lastedShare = convertTokenToDecimal(investor.share, fundEntity.decimals);
    let investorFees = lastedSettlementPrice.minus(investor.lastedSettlementPrice).times(lastedShare);
    investor.lastedSettlementPrice = lastedSettlementPrice;
    investor.totalFees = investor.totalFees.plus(investorFees);
    investor.totalPendingFees = investor.totalPendingFees.plus(investorFees);

    investor.share = investor.share.plus(event.params.share);
    investor.totalInvestment = investor.totalInvestment.plus(depositTx.amount);
    investor.totalInvestmentUSD = investor.totalInvestmentUSD.plus(depositTx.amountUSD);
    investorSummary.totalInvestmentUSD = investorSummary.totalInvestmentUSD.plus(depositTx.amountUSD);
    investor.totalDepositedAmount = investor.totalDepositedAmount.plus(depositTx.amount);
    investor.totalDepositedAmountUSD = investor.totalDepositedAmountUSD.plus(depositTx.amountUSD);
    // investor.totalWithdrewAmount = investor.totalWithdrewAmount;
    investor.lastDepositTime = event.block.timestamp;

    fundEntity.totalFees = fundEntity.totalFees.plus(deltaFees);
    fundEntity.lastedSettlementPrice = lastedSettlementPrice;
    fundEntity.totalPendingFees = fundEntity.totalPendingFees.plus(deltaFees);
    let fundSummary = FundSummary.load("1") as FundSummary;
    fundSummary.totalFees = fundSummary.totalFees.plus(deltaFees);
    fundSummary.totalPendingFees = fundSummary.totalPendingFees.plus(deltaFees);
    fundSummary.totalInvestmentUSD = fundSummary.totalInvestmentUSD.plus(depositTx.amountUSD);
    fundSummary.totalAssetsUSD = fundSummary.totalAssetsUSD.plus(depositTx.amountUSD);

    let manager = Manager.load(fundEntity.manager) as Manager;
    manager.totalInvestmentUSD = manager.totalInvestmentUSD.plus(depositTx.amountUSD);
    manager.totalAssetsUSD = manager.totalAssetsUSD.plus(depositTx.amountUSD);
    manager.totalFees = manager.totalFees.plus(deltaFees);
    manager.totalPendingFees = manager.totalPendingFees.plus(deltaFees);
    // manager.totalWithdrewFees = manager.totalWithdrewFees.plus(deltaFees);

    depositTx.save();
    transaction.save();
    fundEntity.save();
    investor.save();
    investorSummary.save();
    fundSummary.save();
    manager.save();

    updateInvestorDayData(event, investor, lastedShare);
    updateFundDayData(event.block, fundEntity, totalShare);
}

export function handleWithdraw(event: WithdrawEvent): void {
    let fundEntity = Fund.load(event.address.toHex()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(event.address);

    let txId = event.transaction.hash.toHex();
    let transaction = (Transaction.load(txId) || new Transaction(txId)) as Transaction;
    let txWithdraws = (transaction.withdraws || []) as Array<string>;
    let id = txId + "-" + BigInt.fromI32(txWithdraws.length).toString();
    transaction.withdraws = txWithdraws.concat([id]);
    transaction.fund = event.address.toHex();
    syncTxStatusData(transaction, event);

    let fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);
    let withdrawTx = (WithdrawTx.load(id) || new WithdrawTx(id)) as WithdrawTx;
    withdrawTx.transaction = txId;
    withdrawTx.fund = event.address.toHexString();
    withdrawTx.owner = event.params.owner;
    withdrawTx.amount = convertTokenToDecimal(event.params.amount, fundTokenEntity.decimals);
    withdrawTx.amountUSD = withdrawTx.amount.times(fundTokenPriceUSD);

    withdrawTx.share = event.params.share;
    withdrawTx.investor = event.address.toHexString() + "-" + event.params.owner.toHexString();

    syncFundStatusData(fundEntity, fundTokenEntity, fund, fundTokenPriceUSD);
    fundEntity.totalSupply = fund.totalSupply();
    fundEntity.totalInvestment = convertTokenToDecimal(fund.totalInvestment(), fundTokenEntity.decimals);
    // fundEntity.totalDepositedAmount = fundEntity.totalDepositedAmount;
    fundEntity.totalWithdrewAmount = fundEntity.totalWithdrewAmount.plus(withdrawTx.amount);

    let deltaFees = updateFundPools(fundEntity, fundTokenEntity, fund, -1, -1, fundTokenPriceUSD);
    let totalShare = convertTokenToDecimal(fundEntity.totalSupply.plus(event.params.share), fundEntity.decimals);
    let deltaPerSharePrice = totalShare.gt(ZERO_BD) ? deltaFees.div(totalShare) : ZERO_BD;
    let lastedSettlementPrice = fundEntity.lastedSettlementPrice.plus(deltaPerSharePrice);

    let investor = createInvestorEntity(event.address, event.params.owner, event);
    let investorSummary = InvestorSummary.load(event.params.owner.toHex()) as InvestorSummary;
    let investorLastedShare = convertTokenToDecimal(investor.share, fundEntity.decimals);
    let withdrewShare = convertTokenToDecimal(event.params.share, fundEntity.decimals);
    let investorDeltaFees = lastedSettlementPrice.minus(investor.lastedSettlementPrice).times(investorLastedShare);
    let withdrawFees = lastedSettlementPrice.minus(investor.lastedSettlementPrice).times(withdrewShare)
        .plus(investor.totalPendingFees.times(withdrewShare).div(investorLastedShare.gt(ZERO_BD) ? investorLastedShare : ZERO_BD));

    investor.lastedSettlementPrice = lastedSettlementPrice;
    investor.totalFees = investor.totalFees.plus(investorDeltaFees);
    investor.totalPendingFees = investor.totalPendingFees.plus(investorDeltaFees).minus(withdrawFees);
    investor.totalWithdrewFees = investor.totalFees.plus(investor.totalPendingFees);

    investor.share = investor.share.minus(event.params.share);
    let totalInvestmentLasted = investor.totalInvestment;
    investor.totalInvestment = convertTokenToDecimal(fund.investmentOf(event.params.owner), fundTokenEntity.decimals);
    let withdrawInvestment = totalInvestmentLasted.minus(investor.totalInvestment);
    let withdrawInvestmentUSD = totalInvestmentLasted.gt(ZERO_BD) ? withdrawInvestment.times(investor.totalInvestmentUSD).div(totalInvestmentLasted):ZERO_BD;
    //计算协议费用
    let protocolFees = ZERO_BD;
    let protocolFeesUSD = ZERO_BD;
    let baseAmount = withdrawInvestment.plus(withdrawInvestment.times(fundEntity.baseLine));
    let protocolFeesRatio = fundEntity.managerFee.plus(BigDecimal.fromString("0.05"));
    if (withdrawTx.amount.gt(baseAmount)) {
        //提取收益 = 总提取 - 基线值
        //protocolFees = (总提取-基线值) / (1-protocolFeesRatio) * (protocolFeesRatio)
        protocolFees = withdrawTx.amount.minus(withdrawInvestment).times(protocolFeesRatio).div(ONE_BD.minus(protocolFeesRatio));
        protocolFeesUSD = protocolFees.times(fundTokenPriceUSD);
    }

    withdrawTx.protocolFees = protocolFees;
    withdrawTx.protocolFeesUSD = protocolFeesUSD;
    investor.totalProtocolFees = investor.totalProtocolFees.plus(protocolFees);
    investor.totalProtocolFeesUSD = investor.totalProtocolFeesUSD.plus(protocolFeesUSD);
    investor.totalInvestmentUSD = investor.totalInvestmentUSD.minus(withdrawInvestmentUSD);
    investorSummary.totalInvestmentUSD = investorSummary.totalInvestmentUSD.minus(withdrawInvestmentUSD);
    investorSummary.totalProtocolFeesUSD = investorSummary.totalProtocolFeesUSD.plus(protocolFeesUSD);
    // investor.totalDepositedAmount = investor.totalDepositedAmount;
    investor.totalWithdrewAmount = investor.totalWithdrewAmount.plus(withdrawTx.amount);
    investor.totalWithdrewAmountUSD = investor.totalWithdrewAmountUSD.plus(withdrawTx.amountUSD);

    fundEntity.lastedSettlementPrice = lastedSettlementPrice;
    fundEntity.totalFees = fundEntity.totalFees.plus(deltaFees);
    fundEntity.totalPendingFees = fundEntity.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    fundEntity.totalWithdrewFees = fundEntity.totalFees.minus(fundEntity.totalPendingFees);
    fundEntity.totalInvestmentUSD = fundEntity.totalInvestmentUSD.minus(withdrawInvestmentUSD);
    fundEntity.totalWithdrewAmountUSD = fundEntity.totalWithdrewAmountUSD.plus(withdrawTx.amountUSD);
    fundEntity.totalProtocolFees = fundEntity.totalProtocolFees.plus(protocolFees);
    fundEntity.totalProtocolFeesUSD = fundEntity.totalProtocolFeesUSD.plus(protocolFeesUSD);
    let fundSummary = FundSummary.load("1") as FundSummary;
    fundSummary.totalFees = fundSummary.totalFees.plus(deltaFees);
    fundSummary.totalPendingFees = fundSummary.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    fundSummary.totalWithdrewFees = fundSummary.totalFees.minus(fundSummary.totalPendingFees);
    fundSummary.totalInvestmentUSD = fundSummary.totalInvestmentUSD.minus(withdrawInvestmentUSD);
    fundSummary.totalAssetsUSD = fundSummary.totalAssetsUSD.minus(withdrawTx.amountUSD);
    fundSummary.totalProtocolFeesUSD = fundSummary.totalProtocolFeesUSD.plus(protocolFeesUSD);

    let manager = Manager.load(fundEntity.manager) as Manager;
    manager.totalFees = manager.totalFees.plus(deltaFees);
    manager.totalPendingFees = manager.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    manager.totalWithdrewFees = manager.totalFees.minus(manager.totalPendingFees);
    manager.totalInvestmentUSD = manager.totalInvestmentUSD.minus(withdrawInvestmentUSD);
    manager.totalAssetsUSD = manager.totalAssetsUSD.minus(withdrawTx.amountUSD);

    withdrawTx.save();
    transaction.save();
    fundEntity.save();
    investor.save();
    investorSummary.save();
    fundSummary.save();
    manager.save();

    updateInvestorDayData(event, investor, investorLastedShare);
    updateFundDayData(event.block, fundEntity, totalShare);
}

export function handleSetDescriptor(event: SetDescriptor): void {
    let fundEntity = Fund.load(event.address.toHex()) as Fund;
    fundEntity.descriptor = event.params.descriptor.toHexString();

    fundEntity.save();
}

export function handleSetDeadline(event: SetDeadline): void {
    let fundEntity = Fund.load(event.address.toHex()) as Fund;
    fundEntity.deadline = event.params.deadline;

    let txId = event.transaction.hash.toHex();
    let transaction = (Transaction.load(txId) || new Transaction(txId)) as Transaction;
    let txSetDeadline = (transaction.setPaths || []) as Array<string>;
    let id = txId + "-" + BigInt.fromI32(txSetDeadline.length).toString();
    transaction.setDeadlines = txSetDeadline.concat([id]);
    transaction.fund = event.address.toHex();
    syncTxStatusData(transaction, event);

    let setDeadlineTx = new SetDeadlineTx(id);
    setDeadlineTx.transaction = txId;
    setDeadlineTx.fund = event.address.toHex();
    setDeadlineTx.deadline = event.params.deadline;

    fundEntity.save();
    setDeadlineTx.save();
    transaction.save();
}

export function handleSetPath(event: SetPath): void {
    let txId = event.transaction.hash.toHex();
    let transaction = (Transaction.load(txId) || new Transaction(txId)) as Transaction;
    let txSetPaths = (transaction.setPaths || []) as Array<string>;
    let id = txId + "-" + BigInt.fromI32(txSetPaths.length).toString();
    transaction.setPaths = txSetPaths.concat([id]);
    transaction.fund = event.address.toHex();
    syncTxStatusData(transaction, event);

    let setPathTx = new SetPathTx(id);
    setPathTx.transaction = txId;
    setPathTx.fund = event.address.toHex();
    setPathTx.distToken = event.params.distToken.toHex();
    let pathId = event.address.toHex() + "-" + event.params.distToken.toHex();
    setPathTx.path = pathId;

    let path = Path.load(pathId);
    if (path === null) {
        path = new Path(pathId);
        path.fund = setPathTx.fund;
        path.distToken = setPathTx.distToken;
    }

    path.path = event.params.path;
    let pathPools = (path.pathPools || []) as Array<string>;
    pathPools.splice(0, pathPools.length);
    let count = 0;
    let data = event.params.path.toHex().substr(2);
    do {
        let pathPoolId = event.address.toHex() + "-" + event.params.distToken.toHex() + count.toString();
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
    path.pathPools = pathPools;

    path.save();
    setPathTx.save();
    transaction.save();
}

export function handleInit(event: Init): void {
    let fundEntity = Fund.load(event.address.toHex()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(event.address);
    let fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);

    let txId = event.transaction.hash.toHex();
    let transaction = (Transaction.load(txId) || new Transaction(txId)) as Transaction;
    let txInits = (transaction.inits || []) as Array<string>;
    let id = txId + "-" + BigInt.fromI32(txInits.length).toString();
    transaction.inits = txInits.concat([id]);
    transaction.fund = event.address.toHex();
    syncTxStatusData(transaction, event);

    let poolAddress = fund.pools(event.params.poolIndex);
    let uniV3Pool = UniV3Pool.bind(poolAddress);
    let fundPosition = fund.positions(event.params.poolIndex, event.params.positionIndex);
    let poolId = event.address.toHex() + '-' + event.params.poolIndex.toString();
    let positionId = event.address.toHex() + '-' + event.params.poolIndex.toString() + '-' + event.params.positionIndex.toString();

    let initTx = new InitTx(id);
    initTx.transaction = txId;
    initTx.fund = event.address.toHex();
    initTx.token0 = uniV3Pool.token0().toHex();
    initTx.token1 = uniV3Pool.token1().toHex();
    initTx.fee = BigInt.fromI32(uniV3Pool.fee());
    initTx.tickLower = BigInt.fromI32(fundPosition.value1);
    initTx.tickUpper = BigInt.fromI32(fundPosition.value2);
    initTx.amount = convertTokenToDecimal(event.params.amount, fundTokenEntity.decimals);
    initTx.amountUSD = fundTokenPriceUSD.times(initTx.amount);
    initTx.position = positionId;

    let pool = Pool.load(poolId);
    if (pool === null) {
        fundEntity.poolsLength = fundEntity.poolsLength.plus(ONE_BI);
        pool = new Pool(poolId);
        pool.fund = initTx.fund;
        pool.address = poolAddress;
        pool.token0 = initTx.token0;
        pool.token1 = initTx.token1;
        pool.fee = initTx.fee;
        pool.positionsLength = ZERO_BI;
    }
    pool.positionsLength = pool.positionsLength.plus(ONE_BI);
    pool.assetAmount = convertTokenToDecimal(fund.assetsOfPool(event.params.poolIndex), fundTokenEntity.decimals);
    pool.assetShare = fundEntity.totalAssets.gt(ZERO_BD) ? pool.assetAmount.div(fundEntity.totalAssets) : ZERO_BD;
    pool.assetAmountUSD = fundTokenPriceUSD.times(pool.assetAmount);

    let position = new Position(positionId);
    position.pool = poolId;
    position.fund = fundEntity.id;
    position.isEmpty = !event.params.amount.notEqual(ZERO_BI);
    position.tickLower = initTx.tickLower;
    position.tickUpper = initTx.tickUpper;
    position.positionKey = getPositionKey(fundEntity.id, initTx.tickLower, initTx.tickUpper);
    let uniV3Position = uniV3Pool.positions(position.positionKey);
    position.liquidity = uniV3Position.value0;
    //有可能是0，用于结算一段时间内的fees收益
    position.feeGrowthInside0LastX128 = uniV3Position.value1;
    position.feeGrowthInside1LastX128 = uniV3Position.value2;
    position.assetAmount = ZERO_BD;
    position.assetAmountUSD = ZERO_BD;
    position.assetShare = ZERO_BD;
    position.amount0 = ZERO_BD;
    position.amount1 = ZERO_BD;
    position.amount = ZERO_BD;
    position.amountUSD = ZERO_BD;
    position.fees0 = ZERO_BD;
    position.fees1 = ZERO_BD;
    position.fees = ZERO_BD;
    position.feesUSD = ZERO_BD;

    pool.save();
    position.save();
    initTx.save();
    transaction.save();

    //计算fees
    updateFees(event.block, fundEntity, fundTokenEntity, fund, event.params.poolIndex.toI32(), event.params.positionIndex.toI32(), fundTokenPriceUSD);
    fundEntity.save();
}

export function handleAdd(event: Add): void {
    let fundEntity = Fund.load(event.address.toHexString()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(event.address);
    let fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);

    let txId = event.transaction.hash.toHex();
    let transaction = (Transaction.load(txId) || new Transaction(txId)) as Transaction;
    let txAdds = (transaction.adds || []) as Array<string>;
    let id = txId + "-" + BigInt.fromI32(txAdds.length).toString();
    transaction.adds = txAdds.concat([id]);
    transaction.fund = event.address.toHex();
    syncTxStatusData(transaction, event);

    let addTx = (AddTx.load(id) || new AddTx(id)) as AddTx;
    addTx.transaction = txId;
    addTx.fund = event.address.toHex();
    addTx.poolIndex = event.params.poolIndex;
    addTx.positionIndex = event.params.positionIndex;
    addTx.amount = convertTokenToDecimal(event.params.amount, fundTokenEntity.decimals);
    addTx.amountUSD = addTx.amount.times(fundTokenPriceUSD);
    addTx.collect = event.params.collect;
    addTx.position = event.address.toHex() + "-" + addTx.poolIndex.toString() + "-" + addTx.positionIndex.toString();

    updateFees(event.block, fundEntity, fundTokenEntity, fund, event.params.poolIndex.toI32(), event.params.positionIndex.toI32(), fundTokenPriceUSD);

    addTx.save();
    transaction.save();
    fundEntity.save();
}

export function handleSub(event: Sub): void {
    let fundEntity = Fund.load(event.address.toHexString()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(event.address);
    let fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);

    let txId = event.transaction.hash.toHex();
    let transaction = (Transaction.load(txId) || new Transaction(txId)) as Transaction;
    let txSubs = (transaction.subs || []) as Array<string>;
    let id = txId + "-" + BigInt.fromI32(txSubs.length).toString();
    transaction.subs = txSubs.concat([id]);
    transaction.fund = event.address.toHex();
    syncTxStatusData(transaction, event);

    let subTx = (SubTx.load(id) || new SubTx(id)) as SubTx;
    subTx.transaction = txId;
    subTx.fund = event.address.toHex();
    subTx.poolIndex = event.params.poolIndex;
    subTx.positionIndex = event.params.positionIndex;
    subTx.proportion = event.params.proportionX128.toBigDecimal().div(FixedPoint_Q128_BD);
    subTx.position = event.address.toHex() + "-" + subTx.poolIndex.toString() + "-" + subTx.positionIndex.toString();
    subTx.amount = (Position.load(subTx.position) as Position)
        .assetAmount.minus(convertTokenToDecimal(fund.assetsOfPosition(subTx.poolIndex, subTx.positionIndex), fundTokenEntity.decimals));
    if (subTx.amount.lt(ZERO_BD)) subTx.amount = ZERO_BD.minus(subTx.amount);
    subTx.amountUSD = fundTokenPriceUSD.times(subTx.amount);
    updateFees(event.block, fundEntity, fundTokenEntity, fund, event.params.poolIndex.toI32(), event.params.positionIndex.toI32(), fundTokenPriceUSD);

    subTx.save();
    transaction.save();
    fundEntity.save();
}

export function handleMove(event: Move): void {
    let fundEntity = Fund.load(event.address.toHexString()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(event.address);
    let fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);

    let txId = event.transaction.hash.toHex();
    let transaction = (Transaction.load(txId) || new Transaction(txId)) as Transaction;
    let txMoves = (transaction.moves || []) as Array<string>;
    let id = txId + "-" + BigInt.fromI32(txMoves.length).toString();
    transaction.moves = txMoves.concat([id]);
    transaction.fund = event.address.toHex();
    syncTxStatusData(transaction, event);

    let movesTx = (MoveTx.load(id) || new MoveTx(id)) as MoveTx;
    movesTx.transaction = txId;
    movesTx.fund = event.address.toHexString();
    movesTx.poolIndex = event.params.poolIndex;
    movesTx.subIndex = event.params.subIndex;
    movesTx.addIndex = event.params.addIndex;
    movesTx.proportion = event.params.proportionX128.toBigDecimal().div(FixedPoint_Q128_BD);
    movesTx.subPosition = event.address.toHex() + "-" + movesTx.poolIndex.toString() + "-" + movesTx.subIndex.toString();
    movesTx.addPosition = event.address.toHex() + "-" + movesTx.poolIndex.toString() + "-" + movesTx.addIndex.toString();
    movesTx.amount = (Position.load(movesTx.subPosition) as Position)
        .assetAmount.minus(convertTokenToDecimal(fund.assetsOfPosition(movesTx.poolIndex, movesTx.subIndex), fundTokenEntity.decimals));
    if (movesTx.amount.lt(ZERO_BD)) movesTx.amount = ZERO_BD.minus(movesTx.amount);
    movesTx.amountUSD = fundTokenPriceUSD.times(movesTx.amount);
    updateFees(event.block, fundEntity, fundTokenEntity, fund, event.params.poolIndex.toI32(), event.params.subIndex.toI32(), fundTokenPriceUSD);
    updateFees(event.block, fundEntity, fundTokenEntity, fund, event.params.poolIndex.toI32(), event.params.addIndex.toI32(), fundTokenPriceUSD);

    movesTx.save();
    transaction.save();
    fundEntity.save();
}
