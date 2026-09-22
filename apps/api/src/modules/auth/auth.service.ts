import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LoginDto } from './dto/login.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { IdentifyCustomerDto } from './dto/identify-customer.dto';
import { VerifyCustomerOtpDto } from './dto/verify-customer-otp.dto';

interface PendingOtp {
  code: string;
  expiresAt: number;
}

const OTP_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class AuthService {
  /**
   * In-memory OTP store — fine for a single-instance dev/demo deployment. A multi-instance
   * production deployment would move this to Redis/the database with the same interface.
   */
  private readonly pendingOtps = new Map<string, PendingOtp>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { role: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid credentials');
    }

    const matches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = this.jwt.sign({
      sub: user.id,
      type: 'user',
      email: user.email,
      role: user.role.name,
    });

    return {
      accessToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role.name },
    };
  }

  async registerUser(dto: RegisterUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new BadRequestException('A user with this email already exists');
    }

    const role = await this.prisma.role.findUnique({ where: { name: dto.roleName } });
    if (!role) {
      throw new BadRequestException(`Unknown role: ${dto.roleName}`);
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash, name: dto.name, roleId: role.id },
      include: { role: true },
    });

    return { id: user.id, email: user.email, name: user.name, role: user.role.name };
  }

  async identifyCustomer(dto: IdentifyCustomerDto) {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException('Provide at least an email or a phone number');
    }

    let customer = await this.prisma.customer.findFirst({
      where: {
        OR: [dto.email ? { email: dto.email } : undefined, dto.phone ? { phone: dto.phone } : undefined].filter(
          (clause): clause is { email: string } | { phone: string } => clause !== undefined,
        ),
      },
    });

    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          fullName: dto.fullName,
          email: dto.email,
          phone: dto.phone,
          language: dto.language ?? 'ar',
        },
      });
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.pendingOtps.set(customer.id, { code, expiresAt: Date.now() + OTP_TTL_MS });

    await this.notifications.send({
      recipientType: 'CUSTOMER',
      recipientId: customer.id,
      channel: customer.email ? 'EMAIL' : 'SMS',
      subject: 'Your verification code',
      content: `Your verification code is ${code}. It expires in 5 minutes.`,
    });

    const devBypassCode = this.config.get<string>('auth.otpDevBypassCode');

    return {
      customerId: customer.id,
      otpRequired: true,
      // Never leaked in production — there's no real SMS/email gateway wired up yet,
      // so this is how the OTP flow is testable in dev without reading server logs.
      ...(process.env.NODE_ENV !== 'production' ? { devOtp: code } : {}),
      ...(devBypassCode ? { devBypassCode } : {}),
    };
  }

  async verifyCustomerOtp(dto: VerifyCustomerOtpDto) {
    const devBypassCode = this.config.get<string>('auth.otpDevBypassCode');
    const isDevBypass = Boolean(devBypassCode) && dto.code === devBypassCode;

    if (!isDevBypass) {
      const pending = this.pendingOtps.get(dto.customerId);
      if (!pending || pending.expiresAt < Date.now() || pending.code !== dto.code) {
        throw new UnauthorizedException('Invalid or expired verification code');
      }
    }
    this.pendingOtps.delete(dto.customerId);

    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) {
      throw new UnauthorizedException('Customer not found');
    }

    const accessToken = this.jwt.sign({ sub: customer.id, type: 'customer' });
    return { accessToken, customer };
  }
}
