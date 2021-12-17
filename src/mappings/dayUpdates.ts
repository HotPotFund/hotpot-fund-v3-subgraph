import {BigDecimal, BigInt, ethereum} from "@graphprotocol/graph-ts/index";
import {Fund, FundDayData, Investor, InvestorDayData} from "../../generated/schema";
import {ONE_BI, ZERO_BD} from "../helpers";


export function updateInvestorDayData(event: ethereum.Event, investor: Investor, lastedShare: BigDecimal): InvestorDayData {
    //日数据
    let dayMod = event.block.timestamp.div(BigInt.fromI32(86400));
    let dayID = investor.id + "-" + dayMod.toString();
    let dayStartTimestamp = dayMod.times(BigInt.fromI32(86400));

    let investorDayData = InvestorDayData.load(dayID.toString());
    if (investorDayData === null) {
        investorDayData = new InvestorDayData(dayID.toString());
        investorDayData.date = dayStartTimestamp;
        investorDayData.investor = investor.id;
        investorDayData.fund = event.address.toHexString();

        let lastDayMode = dayMod.minus(ONE_BI);
        let fundDayDataLastDay = FundDayData.load(event.address.toHexString() + "-" + lastDayMode.toString());
        //以前投入过且基金已经启动了一天以上
        if (lastedShare.gt(ZERO_BD) && fundDayDataLastDay !== null) {
            investorDayData.dailySettlementPrice = fundDayDataLastDay.dailySettlementPrice;
        } else {//第一天第一次投，或重新开始投
            investorDayData.dailySettlementPrice = investor.lastedSettlementPrice;
        }
        investorDayData.dailyTotalFees = ZERO_BD;
    }
    investorDayData.share = investor.share;
    investorDayData.totalInvestment = investor.totalInvestment;
    investorDayData.totalInvestmentUSD = investor.totalInvestmentUSD;
    investorDayData.totalDepositedAmount = investor.totalDepositedAmount;
    investorDayData.totalDepositedAmountUSD = investor.totalDepositedAmountUSD;
    investorDayData.totalWithdrewAmount = investor.totalWithdrewAmount;
    investorDayData.totalWithdrewAmountUSD = investor.totalWithdrewAmountUSD;

    //因为不一定有上一天的日数据，所以只能通过价格差来算dailyTotalFees
    let fees = investor.lastedSettlementPrice.minus(investorDayData.dailySettlementPrice).times(lastedShare);
    investorDayData.dailySettlementPrice = investor.lastedSettlementPrice;
    investorDayData.dailyTotalFees = investorDayData.dailyTotalFees.plus(fees);

    investorDayData.totalFees = investor.totalFees;//已经结算了
    investorDayData.totalPendingFees = investor.totalPendingFees;//已经结算了
    investorDayData.totalWithdrewFees = investor.totalWithdrewFees;//已经结算了

    investorDayData.save();
    return investorDayData;
}

export function updateFundDayData(block: ethereum.Block, fundEntity: Fund, lastedShare: BigDecimal): FundDayData {
    //日数据
    let dayMod = block.timestamp.div(BigInt.fromI32(86400));
    let dayID = fundEntity.id + "-" + dayMod.toString();

    let fundDayData = FundDayData.load(dayID.toString());
    if (fundDayData === null) {
        fundDayData = new FundDayData(dayID.toString());
        fundDayData.date = dayMod.times(BigInt.fromI32(86400));
        fundDayData.fund = fundEntity.id;

        let lastDayMode = dayMod.minus(ONE_BI);
        let fundDayDataLastDay = FundDayData.load(fundEntity.id + "-" + lastDayMode.toString());
        if (fundDayDataLastDay) {
            fundDayData.dailySettlementPrice = fundDayDataLastDay.dailySettlementPrice;
            fundDayData.totalFees = fundDayDataLastDay.totalFees;
            fundDayData.totalPendingFees = fundDayDataLastDay.totalPendingFees;
        } else {
            fundDayData.dailySettlementPrice = ZERO_BD;
            fundDayData.totalFees = ZERO_BD;
            fundDayData.totalPendingFees = ZERO_BD;
        }
        fundDayData.initSettlementPrice = fundDayData.dailySettlementPrice;
        fundDayData.dailyTotalFees = ZERO_BD;
    }
    fundDayData.totalSupply = fundEntity.totalSupply;
    fundDayData.totalInvestment = fundEntity.totalInvestment;
    fundDayData.totalInvestmentUSD = fundEntity.totalInvestmentUSD;
    fundDayData.totalAssets = fundEntity.totalAssets;
    fundDayData.totalAssetsUSD = fundEntity.totalAssetsUSD;
    fundDayData.totalDepositedAmount = fundEntity.totalDepositedAmount;
    fundDayData.totalDepositedAmountUSD = fundEntity.totalDepositedAmountUSD;
    fundDayData.totalWithdrewAmount = fundEntity.totalWithdrewAmount;
    fundDayData.totalWithdrewAmountUSD = fundEntity.totalWithdrewAmountUSD;

    //因为有上一天的日数据，就可以直接通过两次totalFees的值来算
    fundDayData.dailyTotalFees = fundDayData.dailyTotalFees.plus(fundEntity.totalFees.minus(fundDayData.totalFees));
    // let fees = fundEntity.lastedSettlementPrice.minus(fundDayData.dailySettlementPrice).times(lastedShare);
    fundDayData.dailySettlementPrice = fundEntity.lastedSettlementPrice;
    // fundDayData.dailyTotalFees = fundDayData.dailyTotalFees.plus(fees);

    fundDayData.totalFees = fundEntity.totalFees;//已经结算了
    fundDayData.totalPendingFees = fundEntity.totalPendingFees;//已经结算了
    fundDayData.totalWithdrewFees = fundEntity.totalWithdrewFees;//已经结算了

    fundDayData.save();
    return fundDayData;
}
