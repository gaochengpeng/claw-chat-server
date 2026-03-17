import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";
const secret = new TextEncoder().encode(config.jwtSecret);
export async function signToken(payload) {
    return new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("7d")
        .sign(secret);
}
export async function verifyToken(token) {
    try {
        const { payload } = await jwtVerify(token, secret);
        return { sub: payload.sub, username: payload.username };
    }
    catch {
        return null;
    }
}
