import { Hero } from "@/components/hero";
import { MetricsStrip } from "@/components/metrics-strip";
import { TopologySection } from "@/components/topology/topology-section";
import { ConsoleShowcase } from "@/components/sections/console-showcase";
import { SecuritySection } from "@/components/sections/security-section";
import { OperationsBento } from "@/components/sections/operations-bento";
import { DeploySection } from "@/components/sections/deploy-section";
import { FaqSection } from "@/components/sections/faq-section";
import { FinalCta } from "@/components/sections/final-cta";
import { StructuredData } from "@/components/structured-data";

export default function Home() {
  return (
    <>
      <Hero />
      <MetricsStrip />
      <TopologySection />
      <ConsoleShowcase />
      <SecuritySection />
      <OperationsBento />
      <DeploySection />
      <FaqSection />
      <FinalCta />
      <StructuredData />
    </>
  );
}
