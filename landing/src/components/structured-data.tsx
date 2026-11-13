import { faqs } from "@/lib/content";
import { siteConfig } from "@/lib/site";

function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}

export function StructuredData() {
  const software = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: siteConfig.name,
    description: siteConfig.description,
    url: siteConfig.url,
    applicationCategory: "SecurityApplication",
    applicationSubCategory: "VPN management",
    operatingSystem: "Ubuntu 22.04+ or Debian 12+",
    softwareRequirements:
      "Docker Engine with the Compose plugin, systemd, and a domain or public IP",
    isAccessibleForFree: true,
    license: siteConfig.license,
    codeRepository: siteConfig.repo,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    featureList: [
      "Issue, suspend and revoke WireGuard peers",
      "Manage WireGuard exit nodes across regions",
      "DNS filtering with AdGuard Home",
      "IPv4 and IPv6 blocking before NAT",
      "Passkey and authenticator-app MFA",
      "Audit log, usage CSV export and MFA-gated backups",
    ],
    sameAs: [siteConfig.repo],
  };

  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteConfig.name,
    url: siteConfig.url,
    description: siteConfig.description,
    inLanguage: "en",
    publisher: {
      "@type": "Organization",
      name: "WireGuard Console contributors",
      url: siteConfig.repo,
    },
  };

  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.a,
      },
    })),
  };

  const howTo = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: "Deploy WireGuard Console and add an exit node",
    description:
      "Install the self-hosted console, join a node and issue a peer.",
    totalTime: "PT2M",
    step: [
      {
        "@type": "HowToStep",
        name: "Install the console",
        text: "Run the install one-liner on an Ubuntu 22.04+ or Debian 12+ host with Docker and a domain or public IP.",
      },
      {
        "@type": "HowToStep",
        name: "Join a node",
        text: "Create a node in the console and run its join command on the exit host.",
      },
      {
        "@type": "HowToStep",
        name: "Create a server",
        text: "Set the public endpoint, a unique subnet and DNS servers for that exit.",
      },
      {
        "@type": "HowToStep",
        name: "Issue a peer",
        text: "Add the device to the exit and deliver its WireGuard config.",
      },
    ],
  };

  return (
    <>
      <JsonLd data={software} />
      <JsonLd data={website} />
      <JsonLd data={faqPage} />
      <JsonLd data={howTo} />
    </>
  );
}