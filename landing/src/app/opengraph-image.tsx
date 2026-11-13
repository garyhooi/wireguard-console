import { readFileSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";

export const dynamic = "force-static";

export const runtime = "nodejs";
export const alt =
  "WireGuard Console: every WireGuard exit, one self-hosted control plane";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const regions = ["FRA-1", "SGP-1", "SFO-1", "SYD-1"];

const brandMark = `data:image/png;base64,${readFileSync(
  path.join(process.cwd(), "public/brand-mark.png"),
).toString("base64")}`;

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#09090b",
          color: "#f4f4f5",
          padding: 64,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            background:
              "linear-gradient(135deg, rgba(45,212,191,0.10) 0%, rgba(9,9,11,0) 44%)",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={brandMark}
              width={50}
              height={50}
              alt=""
              style={{ borderRadius: 12 }}
            />
            <div style={{ display: "flex", fontSize: 25, fontWeight: 600 }}>
              WireGuard Console
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 16px",
              border: "1px solid #27272a",
              borderRadius: 999,
              color: "#a1a1aa",
              fontSize: 17,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "#2dd4bf",
              }}
            />
            Self-hosted
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 78,
              fontWeight: 700,
              letterSpacing: -3,
              lineHeight: 1.02,
              maxWidth: 900,
            }}
          >
            One console.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 78,
              fontWeight: 700,
              letterSpacing: -3,
              lineHeight: 1.02,
              color: "#2dd4bf",
            }}
          >
            Every WireGuard exit.
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 26,
              fontSize: 25,
              color: "#a1a1aa",
              maxWidth: 760,
              lineHeight: 1.4,
            }}
          >
            Issue peers, join exit nodes and keep every admin behind MFA.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: "1px solid #27272a",
            paddingTop: 24,
          }}
        >
          <div style={{ display: "flex", gap: 12 }}>
            {regions.map((region) => (
              <div
                key={region}
                style={{
                  display: "flex",
                  padding: "8px 14px",
                  border: "1px solid #27272a",
                  borderRadius: 8,
                  background: "#101012",
                  color: "#d4d4d8",
                  fontSize: 17,
                  letterSpacing: 1,
                }}
              >
                {region}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", color: "#8b8b93", fontSize: 17 }}>
            15s agent poll / no inbound management ports
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}