/**
 * Authentication API service.
 *
 * signup and login use skipAuth: true — no token required.
 * verifyToken uses auth (validates the current token).
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
  });
}

export function login(data: LoginRequest): Promise<LoginResponse> {
  return request<LoginResponse>({
    method: 'POST',
    path: '/api/login',
    body: data,
    skipAuth: true,
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
  });
}
