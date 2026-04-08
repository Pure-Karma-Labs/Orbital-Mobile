/**
 * Authentication API service.
 *
 * signup, login, and getPublicKey use skipAuth: true — no token required.
 * verifyToken uses auth (validates the current token).
 */

import { request } from './client';
import type {
  LoginRequest,
  LoginResponse,
  PublicKeyResponse,
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

export function getPublicKey(username: string): Promise<PublicKeyResponse> {
  return request<PublicKeyResponse>({
    method: 'GET',
    path: `/api/users/${encodeURIComponent(username)}/public-key`,
    skipAuth: true,
  });
}
