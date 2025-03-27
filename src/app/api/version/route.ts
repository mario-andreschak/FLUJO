import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

export async function GET() {
  try {
    // Read package.json to get version
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    return NextResponse.json({
      version: packageJson.version,
      success: true,
    });
  } catch (error) {
    console.error("Error fetching version:", error);

    return NextResponse.json(
      {
        version: "0.1.0",
        success: false,
        error: "Failed to read version information",
      },
      { status: 500 }
    );
  }
}
