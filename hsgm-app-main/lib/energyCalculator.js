/**
 * 한전 주택용(저압) 전력요금 계산 엔진
 * - 기타계절(1~6월, 9~12월): 1단계(200kWh 이하) / 2단계(201~400kWh) / 3단계(400kWh 초과)
 * - 하계(7~8월 누진 완화): 1단계(300kWh 이하) / 2단계(301~450kWh) / 3단계(450kWh 초과)
 */

// 1. 계절별 누진 구간 기준치 판별 함수
export function getTariffTiers(targetMonth = new Date().getMonth() + 1) {
  const isSummer = targetMonth === 7 || targetMonth === 8;
  return {
    isSummer,
    seasonName: isSummer ? "하계 누진 완화(7~8월)" : "기타계절(표준)",
    tier1Limit: isSummer ? 300 : 200,
    tier2Limit: isSummer ? 450 : 400,
  };
}

// 2. 한전 공식 세부 산정 내역 반환 (기본료, 전력량요금, 기후환경, 연료비, 부가세, 전력기금)
export function calculateDetailedBill(usageKWh = 0, targetMonth = new Date().getMonth() + 1) {
  const kwh = Math.max(0, Number(usageKWh) || 0);
  const { isSummer, seasonName, tier1Limit, tier2Limit } = getTariffTiers(targetMonth);

  let baseRate = 0; // 기본요금 (원)
  let energyCharge = 0; // 전력량요금 (원)

  if (kwh <= tier1Limit) {
    baseRate = 910;
    energyCharge = kwh * 120.0;
  } else if (kwh <= tier2Limit) {
    baseRate = 1600;
    energyCharge = tier1Limit * 120.0 + (kwh - tier1Limit) * 214.6;
  } else {
    baseRate = 7300;
    energyCharge =
      tier1Limit * 120.0 +
      (tier2Limit - tier1Limit) * 214.6 +
      (kwh - tier2Limit) * 307.3;
  }

  // 기후환경요금: 9.0원/kWh
  const climateCharge = Math.round(kwh * 9.0);

  // 연료비조정액: +5.0원/kWh (기준단가 반영)
  const fuelAdjustmentCharge = Math.round(kwh * 5.0);

  // 전기요금 합계 (원미만 절사)
  const subtotal = Math.floor(baseRate + energyCharge + climateCharge + fuelAdjustmentCharge);

  // 부가가치세 (10%, 사사오입)
  const vat = Math.round(subtotal * 0.1);

  // 전력산업기반기금 (3.7%, 10원 미만 절사)
  const powerFund = Math.floor((subtotal * 0.037) / 10) * 10;

  // 최종 청구금액 (10원 미만 절사)
  const totalBill = Math.floor((subtotal + vat + powerFund) / 10) * 10;

  // 현재 구간 단계 (1, 2, 3)
  const currentTier = kwh > tier2Limit ? 3 : kwh > tier1Limit ? 2 : 1;

  return {
    totalBill,
    subtotal,
    baseRate,
    energyCharge: Math.round(energyCharge),
    climateCharge,
    fuelAdjustmentCharge,
    vat,
    powerFund,
    currentTier,
    isSummer,
    seasonName,
    tier1Limit,
    tier2Limit,
  };
}

// 3. 기존 대시보드 및 컴포넌트 호환용 (단일 최종 청구금액 숫자 반환)
export function calculateKepcoBill(usageKWh = 0, targetMonth = new Date().getMonth() + 1) {
  return calculateDetailedBill(usageKWh, targetMonth).totalBill;
}

// 4. 등록 가전 목록(devices) 기반 실시간 전력 & 예상 청구액 통합 집계 함수
export function calculateDevicesSummary(devices = [], targetMonth = new Date().getMonth() + 1) {
  if (!Array.isArray(devices) || devices.length === 0) {
    return {
      activeCount: 0,
      totalActiveWatts: 0,
      totalMonthlyKWh: 0,
      billDetails: calculateDetailedBill(0, targetMonth),
    };
  }

  // 1) 현재 가동 중인 가전의 소비전력 합산 (W)
  const activeDevices = devices.filter((d) => d.status);
  const totalActiveWatts = activeDevices.reduce(
    (sum, d) => sum + (Number(d.currentPower) || 0),
    0
  );

  // 2) 등록된 전체 가전의 월간 예상 소비전력량 합산 (kWh/월)
  const totalMonthlyKWh = devices.reduce(
    (sum, d) => sum + (Number(d.monthlyUsageKWh) || 0),
    0
  );

  // 3) 누진세 적용 최종 요금 세부 내역
  const billDetails = calculateDetailedBill(totalMonthlyKWh, targetMonth);

  return {
    activeCount: activeDevices.length,
    totalActiveWatts,
    totalMonthlyKWh: Math.round(totalMonthlyKWh * 10) / 10,
    billDetails,
  };
}

// 5. 에너지 효율 1등급 대비 구형 등급(하락 기기)의 연간 전기요금 차액 산출
export function calculateGradeSavings(monthlyUsageKWh = 35, gradeDiff = 1) {
  const kwh = Number(monthlyUsageKWh) || 35;
  // 통상 1등급 하락 시 전력소모량 약 15~20% 증가
  const penaltyRatio = Math.max(0.1, gradeDiff * 0.15);
  const excessKWh = kwh * penaltyRatio;
  
  // 누진 2단계 단가(약 214.6원 + 부가세/기금 = 약 260원/kWh) 기준 연간 추가 비용
  const annualLoss = Math.round(excessKWh * 260 * 12);
  return {
    excessKWh: Math.round(excessKWh * 10) / 10,
    annualLoss,
  };
}