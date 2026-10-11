/**
 * 详情里的一节：小标题加内容（AgentSense DetailPane.tsx 的 Section，milestone.tsx 的 Sec 同一个样子）。
 * 详情面板、计划详情、阶段详情、出过的状况都用这一个
 */
import type { ReactNode } from "react";

export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="dt-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}
