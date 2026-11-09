export declare const config: { runtime: string; matcher: string[] };
export declare function passwordOk(header: string | null | undefined, password: string): boolean;
export default function middleware(request: Request): Response | undefined;
