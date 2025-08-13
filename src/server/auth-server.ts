import type { IncomingMessage, ServerResponse } from "http";
import { URL } from "url";
import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import { AuthRoutes } from "../auth/auth-routes.ts";
import { AgentsRoutes } from "../agents/agents-routes.ts";

export class AuthServer {
  private runtime: IAgentRuntime;
  private authRoutes: AuthRoutes;
  private agentsRoutes: AgentsRoutes;
  private server: any;

  /**
   * You can pass opts (currently unused) to keep the constructor compatible with callers.
   */
  constructor(
    runtime: IAgentRuntime,
    _opts?: { elizaBaseUrl?: string; timeoutMs?: number }
  ) {
    this.runtime = runtime;
    this.authRoutes = new AuthRoutes(runtime);
    this.agentsRoutes = new AgentsRoutes(runtime);
  }

  // ---------- utilities ----------

  private parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", (err) => reject(err));
    });
  }

  private setCorsHeaders(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    res.setHeader("Access-Control-Max-Age", "3600");
  }

  /**
   * Keep your existing response convention:
   * - HTTP status code in the status line
   * - body is exactly `data`
   */
  private sendJsonResponse(res: ServerResponse, status: number, data: any): void {
    this.setCorsHeaders(res);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  }

  // ---------- auth + agents (kept from HEAD) ----------

  private async handleAuthRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<boolean> {
    this.setCorsHeaders(res);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 200;
      res.end();
      return true;
    }

    try {
      // --- Auth endpoints ---
      if (pathname === "/auth/register" && req.method === "POST") {
        const body = await this.parseBody(req);
        const result = await this.authRoutes.handleRegister(body);
        this.sendJsonResponse(res, result.status, result.data);
        return true;
      }

      if (pathname === "/auth/login" && req.method === "POST") {
        const body = await this.parseBody(req);
        const result = await this.authRoutes.handleLogin(body);
        this.sendJsonResponse(res, result.status, result.data);
        return true;
      }

      if (pathname === "/auth/verify" && req.method === "POST") {
        const body = await this.parseBody(req);
        const token =
          body.token || req.headers.authorization?.replace("Bearer ", "");
        if (!token) {
          this.sendJsonResponse(res, 401, {
            success: false,
            message: "Token required",
          });
          return true;
        }
        const result = await this.authRoutes.handleVerifyToken(token);
        this.sendJsonResponse(res, result.status, result.data);
        return true;
      }

      if (pathname === "/auth/delete-history" && req.method === "DELETE") {
        const body = await this.parseBody(req);
        const result = await this.authRoutes.handleDeleteHistory(body);
        this.sendJsonResponse(res, result.status, result.data);
        return true;
      }

      // --- Agents endpoints (kept from HEAD) ---
      if (pathname.startsWith("/agents/by-name") && req.method === "GET") {
        const urlObj = new URL(req.url || "/", `http://${req.headers.host}`);
        const name = urlObj.searchParams.get("name") || "GraceFletcher";
        const result = await this.agentsRoutes.handleGetByName(name);
        this.sendJsonResponse(res, result.status, result.data);
        return true;
      }

      if (pathname.startsWith("/agents/by-name") && req.method === "PUT") {
        const urlObj = new URL(req.url || "/", `http://${req.headers.host}`);
        const name = urlObj.searchParams.get("name") || "GraceFletcher";
        const body = await this.parseBody(req);
        const result = await this.agentsRoutes.handleUpdateByName(name, body || {});
        this.sendJsonResponse(res, result.status, result.data);
        return true;
      }

      // 404s for /auth/* or /agents/* that weren't matched above
      if (pathname.startsWith("/auth/") || pathname.startsWith("/agents/")) {
        this.sendJsonResponse(res, 404, {
          success: false,
          message: "Endpoint not found",
        });
        return true;
      }
    } catch (error) {
      elizaLogger.error("Request error:", error);
      this.sendJsonResponse(res, 500, {
        success: false,
        message: "Internal server error",
      });
      return true;
    }

    return false; // Not an auth/agents request
  }

  // ---------- discovery (new, minimal) ----------

  /**
   * Discovery endpoints (very small surface):
   * GET /discovery/comprehensive-record?userId=...&roomId=...
   *
   * Calls getComprehensiveRecord() from ../actions/grand-villa-discovery.ts
   * as requested (no DiscoveryRoutes helper).
   */
  async handleDiscovery(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    this.setCorsHeaders(res);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 200;
      res.end();
      return true;
    }

    try {
      const urlObj = new URL(req.url || "/", `http://${req.headers.host}`);
      const pathname = urlObj.pathname;

      if (
        pathname.startsWith("/discovery/comprehensive-record") &&
        req.method === "GET"
      ) {
        const userId = urlObj.searchParams.get("userId");
        const roomId = urlObj.searchParams.get("roomId");

        if (!userId || !roomId) {
          this.sendJsonResponse(res, 400, {
            success: false,
            message: "userId and roomId are required",
          });
          return true;
        }

        const result = await this.handleGetComprehensiveRecord(userId, roomId);
        this.sendJsonResponse(res, result.status, result.data);
        return true;
      }

      // Any other /discovery/* goes 404 to keep the surface strict
      if (pathname.startsWith("/discovery/")) {
        this.sendJsonResponse(res, 404, {
          success: false,
          message: "Endpoint not found",
        });
        return true;
      }
    } catch (error) {
      elizaLogger.error("Discovery request error:", error);
      this.sendJsonResponse(res, 500, {
        success: false,
        message: "Internal server error",
      });
      return true;
    }

    return false; // Not a discovery request
  }

  /**
   * Wrapper that calls the existing action's getComprehensiveRecord()
   * and normalizes the response.
   */
  private async handleGetComprehensiveRecord(
    userId: string,
    roomId: string
  ): Promise<{ status: number; data: any }> {
    try {
      // Lazy import to avoid any circular deps
      const mod: any = await import("../actions/grand-villa-discovery.ts");
      const fn =
        mod?.getComprehensiveRecord ??
        mod?.grandVillaDiscoveryAction?.getComprehensiveRecord;

      if (typeof fn !== "function") {
        return {
          status: 500,
          data: { success: false, message: "getComprehensiveRecord() not found in grand-villa-discovery.ts" },
        };
      }

      // Support both common signatures
      let record: any;
      try {
        record = await fn(this.runtime, { userId, roomId });
      } catch {
        record = await fn(this.runtime, userId, roomId);
      }

      return { status: 200, data: { success: true, record } };
    } catch (err: any) {
      elizaLogger.error("getComprehensiveRecord error:", err);
      return {
        status: 500,
        data: { success: false, message: "Internal error", details: String(err?.message || err) },
      };
    }
  }

  // ---------- middleware + helpers ----------

  createMiddleware() {
    return async (
      req: IncomingMessage,
      res: ServerResponse,
      next?: () => void
    ) => {
      const urlObj = new URL(req.url || "/", `http://${req.headers.host}`);
      const pathname = urlObj.pathname;

      const handled = await this.handleAuthRequest(req, res, pathname);
      if (!handled && next) next();
    };
  }

  getAuthService() {
    return this.authRoutes.getAuthService();
  }

  getUserDatabase() {
    return this.authRoutes.getUserDatabase();
  }
}
