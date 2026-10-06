/**
 * Authentication API service.
 *
 * signup and login use skipAuth: true — no token required.
 * verifyToken uses auth (validates the current token).
 *
 * The four user-initiated routes here set retryOn429: false. They sit behind
 * the backend's IP-keyed `authLimiter` — a FIXED window of 10 requests per 15
 * minutes shared across every auth route — so an automatic retry does not wait
 * out the limit, it spends three more of the user's ten slots and then reports
 * the same failure ~7 seconds later. verifyToken keeps the default retry: it is
 * a background token check, not a tap, and a transient 429 there should not
 * look like a logout.
 */

import { request } from './client';
import type {
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  LoginRequest,
  LoginResponse,
  ResetPasswordWithCodeRequest,
  ResetPasswordWithCodeResponse,
  SignupRequest,
  SignupResponse,
  VerifyTokenResponse,
} from '../../types/api';

export function signup(data: SignupRequest): Promise<SignupResponse> {
  return request<SignupResponse>({
    method: 'POST',
    path: '/api/signup',
    body: data,
    skipAuth: true,
    retryOn429: false,
  });
}

export function login(data: LoginRequest): Promise<LoginResponse> {
  return request<LoginResponse>({
    method: 'POST',
    path: '/api/login',
    body: data,
    skipAuth: true,
    retryOn429: false,
  });
}

export function verifyToken(): Promise<VerifyTokenResponse> {
  return request<VerifyTokenResponse>({
    method: 'POST',
    path: '/api/verify-token',
  });
}

export function forgotPassword(
  email: string,
): Promise<ForgotPasswordResponse> {
  return request<ForgotPasswordResponse>({
    method: 'POST',
    path: '/api/forgot-password',
    body: { email } as ForgotPasswordRequest,
    skipAuth: true,
    retryOn429: false,
  });
}

export function resetPasswordWithCode(
  email: string,
  code: string,
  newPassword: string,
): Promise<ResetPasswordWithCodeResponse> {
  return request<ResetPasswordWithCodeResponse>({
    method: 'POST',
    path: '/api/reset-password-with-code',
    body: { email, code, newPassword } as ResetPasswordWithCodeRequest,
    skipAuth: true,
    retryOn429: false,
  });
}
