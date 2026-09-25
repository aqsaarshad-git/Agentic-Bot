import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';
import { VerificationService } from '../verification/verification.service';
import { LoginDto } from './dto/login.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { IdentifyCustomerDto } from './dto/identify-customer.dto';
import { VerifyCustomerOtpDto } from './dto/verify-customer-otp.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly verification: VerificationService,
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

    const { code } = await this.verification.createSession({ customerId: customer.id, purpose: 'IDENTITY' });

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
    await this.verification.verifyOtp({ customerId: dto.customerId, purpose: 'IDENTITY', code: dto.code });

    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) {
      throw new UnauthorizedException('Customer not found');
    }

    const accessToken = this.jwt.sign({ sub: customer.id, type: 'customer' });
    return { accessToken, customer };
  }
}
