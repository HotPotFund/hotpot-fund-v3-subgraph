import { FundCreated } from "../../generated/Factory/Factory";
import { Fund as FundContract } from "../../generated/Factory/Fund";

import { Address, BigInt } from "@graphprotocol/graph-ts/index";
import { Fund, FundSummary, Manager } from "../../generated/schema";
import { Fund as FundTemplate } from "../../generated/templates";
import {
    fetchTokenDecimals,
    fetchTokenName,
    fetchTokenSymbol,
    ONE_BI,
    WETH_ADDRESS,
    ZERO_BD,
    ZERO_BI
} from "../helpers";


function getFundTokenAddr(contract: FundContract): Address {
    let tokenResult = contract.try_token();
    if (tokenResult.reverted)
        return Address.fromString(WETH_ADDRESS);
    else
        return tokenResult.value;
}

export function handleFundCreated(event: FundCreated): void {
    let address = event.params.fund;
    let fundContract = FundContract.bind(address);
    let fundTokenAddr = getFundTokenAddr(fundContract);

    let fundEntity = new Fund(address.toHexString());
    fundEntity.summary = "1";
    fundEntity.symbol = fetchTokenSymbol(address);
    fundEntity.name = fetchTokenName(address);
    fundEntity.decimals = fetchTokenDecimals(address);
    fundEntity.lockPeriod = fundContract.lockPeriod();
    fundEntity.baseLine = fundContract.baseLine().toBigDecimal().div(BigInt.fromI32(100).toBigDecimal());
    fundEntity.managerFee = fundContract.managerFee().toBigDecimal().div(BigInt.fromI32(100).toBigDecimal());
    fundEntity.deadline = fundContract.depositDeadline();

    let manager = Manager.load(event.params.manager.toHex());
    if (manager === null) {
        manager = new Manager(event.params.manager.toHex());
        manager.length = ZERO_BI;
        // manager.funds = manager.funds || [];
        manager.totalInvestmentUSD = ZERO_BD;
        manager.totalAssetsUSD = ZERO_BD;
        manager.totalFees = ZERO_BD;
        manager.totalPendingFees = ZERO_BD;
        manager.totalWithdrewFees = ZERO_BD;
        manager.save();
    }

    fundEntity.manager = event.params.manager.toHex();
    fundEntity.descriptor = fundContract.descriptor().toHexString();
    fundEntity.fundToken = fundTokenAddr.toHex();
    fundEntity.balance = ZERO_BD;

    // fundEntity.pools = [];
    fundEntity.poolsLength = ZERO_BI;
    // fundEntity.buyPath = [];
    // fundEntity.sellPath = [];

    fundEntity.totalSupply = ZERO_BI;
    fundEntity.totalInvestment = ZERO_BD;
    fundEntity.totalInvestmentUSD = ZERO_BD;
    fundEntity.totalAssets = ZERO_BD;
    fundEntity.totalAssetsUSD = ZERO_BD;

    fundEntity.totalDepositedAmount = ZERO_BD;
    fundEntity.totalDepositedAmountUSD = ZERO_BD;
    fundEntity.totalWithdrewAmount = ZERO_BD;
    fundEntity.totalWithdrewAmountUSD = ZERO_BD;

    fundEntity.lastedSettlementPrice = ZERO_BD;
    fundEntity.totalFees = ZERO_BD;
    fundEntity.totalPendingFees = ZERO_BD;
    fundEntity.totalWithdrewFees = ZERO_BD;
    fundEntity.totalProtocolFees = ZERO_BD;
    fundEntity.totalProtocolFeesUSD = ZERO_BD;

    fundEntity.save();

    let fundSummary = FundSummary.load("1");
    if (!fundSummary) {
        fundSummary = new FundSummary("1");
        fundSummary.length = ZERO_BI;
        fundSummary.totalFees = ZERO_BD;
        fundSummary.totalPendingFees = ZERO_BD;
        fundSummary.totalWithdrewFees = ZERO_BD;
        fundSummary.totalInvestmentUSD = ZERO_BD;
        fundSummary.totalAssetsUSD = ZERO_BD;
        fundSummary.totalProtocolFeesUSD = ZERO_BD;
    }
    fundSummary.length = fundSummary.length.plus(ONE_BI);
    let funds = (fundSummary.funds || []) as Array<string>;
    funds.push(address.toHexString());
    fundSummary.funds = funds;
    fundSummary.save();

    // create the tracked contract based on the template
    FundTemplate.create(address);
}
