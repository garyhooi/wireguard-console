import { metrics } from "@/lib/content";

export function MetricsStrip() {
  return (
    <section aria-label="Operational facts" className="relative border-y border-line bg-panel/40">
      <dl className="mx-auto grid w-full max-w-[1320px] grid-cols-2 px-5 sm:px-8 lg:grid-cols-4">
        {metrics.map((metric, index) => (
          <div
            key={metric.label}
            className={
              index === 0
                ? "py-7 pr-5 sm:py-8 lg:pr-8"
                : "border-l border-line/70 py-7 pl-5 sm:py-8 sm:pl-8"
            }
          >
            <dt className="sr-only">{metric.label}</dt>
            <dd>
              <span className="block text-[1.65rem] font-medium tracking-[-0.03em] text-text sm:text-[1.85rem]">
                {metric.value}
              </span>
              <span className="mt-1.5 block font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-dim">
                {metric.label}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
