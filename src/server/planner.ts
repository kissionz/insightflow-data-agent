import { OpenAIModel } from "montane-code";
import type {
  Conversation,
  OntologySnapshot,
  PhysicalTable,
} from "../shared/types.js";

export interface QueryPlan {
  sql: string;
  resultKind: "aggregate" | "detail";
  title: string;
  explanation: string;
}

export class MontaneSemanticPlanner {
  async plan(
    question: string,
    ontology: OntologySnapshot,
    tables: PhysicalTable[],
    conversation: Conversation,
  ): Promise<QueryPlan | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    const modelName = process.env.OPENAI_MODEL;
    if (!apiKey || !modelName) return null;

    const model = new OpenAIModel({
      apiKey,
      model: modelName,
      baseUrl: process.env.OPENAI_BASE_URL,
    });
    const response = await model.complete({
      tools: [],
      maxOutputTokens: 1_800,
      messages: [
        {
          role: "system",
          content: [
            "你是 InsightFlow 的语义查询规划器。",
            "根据已发布 Ontology 生成一条适用于 SelectDB/Doris 的只读 SQL。",
            "仅输出严格 JSON，不要 Markdown。",
            'JSON 结构：{"sql":"...","resultKind":"aggregate|detail","title":"...","explanation":"..."}。',
            "禁止修改数据，禁止猜测不存在的表或字段。",
            "历史问题仅用于解析代词和省略条件。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            question,
            recentQuestions: conversation.turns.slice(-3).map((turn) => turn.question),
            ontology: {
              version: ontology.version,
              objects: ontology.objects.map((object) => ({
                id: object.id,
                label: object.label,
                sourceTable: tables.find((table) => table.id === object.sourceTableId)?.name,
                properties: object.properties.map((property) => ({
                  label: property.label,
                  column: property.sourceColumn,
                  dataType: property.dataType,
                })),
              })),
              relations: ontology.relations.map((relation) => ({
                sourceObjectId: relation.sourceObjectId,
                targetObjectId: relation.targetObjectId,
                joinExpression: relation.joinExpression,
                cardinality: relation.cardinality,
                fanoutRisk: relation.fanoutRisk,
              })),
              metrics: ontology.metrics.map((metric) => ({
                label: metric.label,
                expression: metric.expression,
                synonyms: metric.synonyms,
              })),
            },
          }),
        },
      ],
    });

    if (!response.finalText) throw new Error("模型未返回查询计划");
    const parsed = JSON.parse(extractJson(response.finalText)) as Partial<QueryPlan>;
    if (
      !parsed.sql ||
      !parsed.title ||
      !parsed.explanation ||
      !["aggregate", "detail"].includes(parsed.resultKind ?? "")
    ) {
      throw new Error("模型返回的查询计划结构不完整");
    }
    return parsed as QueryPlan;
  }
}

function extractJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
