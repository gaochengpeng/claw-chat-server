import bcryptjs from "bcryptjs";
const SALT_ROUNDS = 10;
export async function hashPassword(plain) {
    return bcryptjs.hash(plain, SALT_ROUNDS);
}
export async function comparePassword(plain, hash) {
    return bcryptjs.compare(plain, hash);
}
