import catalogData from "@/data/appliance_catalog.json";
import { keaService } from "@/services/keaService";
import { evaluateDeviceGrade } from "@/lib/energyGrade";

/**
 * 카테고리 표준화 매핑 테이블 (한글/영문 양방향 변환)
 */
const CATEGORY_MAP = {
  냉장고: "refrigerator",
  김치냉장고: "kimchi_fridge",
  세탁기: "washer",
  건조기: "dryer",
  에어컨: "air_conditioner",
  공기청정기: "air_purifier",
  tv: "tv",
  티비: "tv",
  텔레비전: "tv",
  밥솥: "cooker",
  전기밥솥: "cooker",
  전자레인지: "microwave",
  식기세척기: "dishwasher",
  로봇청소기: "robot_cleaner",
  청소기: "robot_cleaner",
  노트북: "laptop",
  컴퓨터: "laptop",
};

/**
 * 키워드 정규화 및 정리
 */
function cleanText(str) {
  if (!str) return "";
  return String(str).toUpperCase().replace(/[^A-Z0-9가-힣]/g, "");
}

function normalizeCategory(cat) {
  if (!cat) return "";
  const lower = String(cat).toLowerCase().trim().replace(/_/g, "");
  for (const [k, v] of Object.entries(CATEGORY_MAP)) {
    if (lower === k.toLowerCase() || lower === v.toLowerCase().replace(/_/g, "")) {
      return v;
    }
  }
  return lower;
}

function cleanCategoryMatch(cat1, cat2) {
  if (!cat1 || !cat2) return false;
  const n1 = normalizeCategory(cat1);
  const n2 = normalizeCategory(cat2);
  return n1 === n2 || n1.includes(n2) || n2.includes(n1);
}

export const deviceMatcher = {
  /**
   * 1단계: 내부 공인 카탈로그 + KEA 공공 API 하이브리드 매칭
   */
  async matchAppliance(extractedInfo) {
    const rawModel = extractedInfo.model || extractedInfo.model_code || "";
    const rawBrand = extractedInfo.brand || "";
    const rawCategory = extractedInfo.category || "";
    const rawName = extractedInfo.name || extractedInfo.lineup_guess || "";

    const cleanM = cleanText(rawModel);
    const cleanB = cleanText(rawBrand);
    const cleanN = cleanText(rawName);

    // 1-A. 내부 카탈로그에서 모델 프리픽스 매칭 (0ms)
    for (const item of catalogData) {
      // 1) modelPrefix 배열 매칭
      if (item.modelPrefix && Array.isArray(item.modelPrefix)) {
        for (const prefix of item.modelPrefix) {
          const cleanP = cleanText(prefix);
          if ((cleanM && cleanM.includes(cleanP)) || (cleanN && cleanN.includes(cleanP))) {
            return { matchType: "catalog_prefix", item };
          }
        }
      }

      // 2) 브랜드 + 카테고리 일치 매칭 (외형 촬영 시 카탈로그 RAG 바인딩 핵심)
      const itemBrand = cleanText(item.brand);
      const isBrandMatch = cleanB.includes(itemBrand) || cleanN.includes(itemBrand) || itemBrand.includes(cleanB);
      const isCatMatch = cleanCategoryMatch(rawCategory, item.category);

      if (isBrandMatch && isCatMatch) {
        return { matchType: "catalog_brand_category", item };
      }
    }

    // 1-B. 한국에너지공단(KEA) 실시간 OpenAPI 조회 (정밀 모델명이 있을 때)
    if (rawModel && rawModel.length >= 3) {
      try {
        const keaResult = await keaService.searchDeviceByModel(rawModel);
        if (keaResult) {
          return { matchType: "kea_api", item: keaResult };
        }
      } catch (e) {
        // 무시 후 카탈로그 기본값으로 처리
      }
    }

    // 1-C. 브랜드는 불명확하지만 카테고리가 일치하는 경우의 기본 카탈로그 Fallback
    const fallbackCategoryItem = catalogData.find((item) =>
      cleanCategoryMatch(rawCategory, item.category)
    );
    if (fallbackCategoryItem) {
      return { matchType: "catalog_category_fallback", item: fallbackCategoryItem };
    }

    return null;
  },

  /**
   * 2단계: 누락/모호한 슬롯 감지 및 대화형 역질문 생성
   */
  generateClarificationOrFinal(extractedInfo, matchedResult) {
    if (matchedResult && matchedResult.item) {
      const item = matchedResult.item;

      // 하위 파생 모델(용량/평형/형태 등)이 복수 개 존재하는 경우 ➔ 역질문 생성
      if (item.subModels && Array.isArray(item.subModels) && item.subModels.length > 1) {
        const userAnswersStr = cleanText(JSON.stringify(extractedInfo.answers || ""));
        const matchedSub = item.subModels.find(
          (sub) =>
            userAnswersStr.includes(cleanText(sub.id)) ||
            userAnswersStr.includes(cleanText(sub.capacity)) ||
            userAnswersStr.includes(cleanText(sub.label))
        );

        if (matchedSub) {
          return {
            status: "complete",
            device: this.buildFinalDevice(item, matchedSub, extractedInfo),
          };
        }

        return {
          status: "needs_clarification",
          matchedBrand: item.brand,
          matchedName: item.name,
          category: item.category,
          question: `${item.brand} ${item.name} 라인업을 확인했습니다! 세부 평형이나 용량을 선택해주세요:`,
          options: item.subModels.map((sub) => ({
            id: sub.id,
            label: sub.label,
            capacity: sub.capacity,
            powerConsumption: sub.powerConsumption,
            monthlyUsageKWh: sub.monthlyUsageKWh,
            monthlyCost: sub.monthlyCost,
            releaseEnergyGrade: sub.releaseEnergyGrade,
          })),
          partialDevice: {
            brand: item.brand,
            name: item.name,
            model: extractedInfo.model || extractedInfo.model_code || item.modelPrefix?.[0] || "MODEL-SCAN",
            category: item.category,
            icon: item.icon,
            asInfo: item.asInfo,
            consumables: item.consumables,
          },
        };
      }

      const sub = item.subModels?.[0] || {};
      return {
        status: "complete",
        device: this.buildFinalDevice(item, sub, extractedInfo),
      };
    }

    // 매칭 실패 시 기본 완성
    const defaultGrade = extractedInfo.energyGrade || 1;
    const finalDev = evaluateDeviceGrade({
      name: extractedInfo.name || "스마트 가전",
      brand: extractedInfo.brand || "기타",
      model: extractedInfo.model || extractedInfo.model_code || "MODEL-" + Date.now().toString().slice(-4),
      category: normalizeCategory(extractedInfo.category) || "air_conditioner",
      icon: extractedInfo.icon || "Zap",
      status: false,
      currentPower: 0,
      monthlyUsageKWh: Number(extractedInfo.monthlyUsageKWh || 35),
      monthlyCost: Number(extractedInfo.monthlyCost || 8500),
      annualEstimatedCost: Number(extractedInfo.monthlyCost || 8500) * 12,
      energyGrade: defaultGrade,
      releaseEnergyGrade: defaultGrade,
      releaseYear: extractedInfo.releaseYear || "2024",
      specs: {
        powerConsumption: extractedInfo.power || extractedInfo.powerConsumption || "공인 표준",
        releaseYear: extractedInfo.releaseYear || "2024",
        ...(extractedInfo.specs || {}),
      },
      asInfo: extractedInfo.asInfo || {
        center: "공식 서비스센터",
        phone: "1544-7777",
        siteUrl: "https://www.lge.co.kr",
      },
      consumables: extractedInfo.consumables || [],
    });

    return {
      status: "complete",
      device: finalDev,
    };
  },

  /**
   * 최종 확정된 기기 객체 빌드
   */
  buildFinalDevice(item, subModel, extractedInfo) {
    const rawReleaseGrade = subModel.releaseEnergyGrade || item.releaseEnergyGrade || extractedInfo.energyGrade || 1;
    const rawReleaseYear = subModel.releaseYear || item.releaseYear || extractedInfo.releaseYear || "2024";

    const baseDev = {
      name: `${item.brand} ${item.name} (${subModel.capacity || subModel.label || ""})`.trim(),
      brand: item.brand || extractedInfo.brand || "제조사",
      model: extractedInfo.model || extractedInfo.model_code || item.modelPrefix?.[0] || "MODEL-" + Date.now().toString().slice(-4),
      category: item.category || normalizeCategory(extractedInfo.category) || "air_conditioner",
      icon: item.icon || "Zap",
      status: false,
      currentPower: 0,
      monthlyUsageKWh: subModel.monthlyUsageKWh || item.monthlyUsageKWh || 35.0,
      monthlyCost: subModel.monthlyCost || item.monthlyCost || 8800,
      annualEstimatedCost: (subModel.monthlyCost || item.monthlyCost || 8800) * 12,
      releaseEnergyGrade: rawReleaseGrade,
      energyGrade: rawReleaseGrade,
      releaseYear: String(rawReleaseYear),
      specs: {
        capacity: subModel.capacity || "표준 용량",
        powerConsumption: subModel.powerConsumption || item.powerConsumption || "공인 표준 전력",
        coolingCapacity: subModel.coolingCapacity,
        warrantyPeriod: subModel.warrantyPeriod || "제조사 무상 보증 10년",
        releaseYear: String(rawReleaseYear),
      },
      asInfo: item.asInfo || {
        center: "공식 고객센터",
        phone: "1544-7777",
        siteUrl: "https://www.lge.co.kr",
      },
      consumables: item.consumables || [],
    };

    return evaluateDeviceGrade(baseDev);
  },
};