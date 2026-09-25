import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class BeneficiariesService {
  constructor(private readonly prisma: PrismaService) {}

  findForCustomer(customerId: string) {
    return this.prisma.beneficiary.findMany({
      where: { customerId, status: { not: 'REMOVED' } },
      orderBy: { addedAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const beneficiary = await this.prisma.beneficiary.findUnique({ where: { id } });
    if (!beneficiary) {
      throw new NotFoundException(`Beneficiary ${id} not found`);
    }
    return beneficiary;
  }

  async findOneForCustomer(id: string, customerId: string) {
    const beneficiary = await this.findOne(id);
    if (beneficiary.customerId !== customerId) {
      throw new NotFoundException(`Beneficiary ${id} not found`);
    }
    return beneficiary;
  }

  async add(params: {
    customerId: string;
    beneficiaryName: string;
    accountNumber: string;
    bankName?: string;
    bankCode?: string;
    nickname?: string;
  }) {
    const existing = await this.prisma.beneficiary.findUnique({
      where: { customerId_accountNumber: { customerId: params.customerId, accountNumber: params.accountNumber } },
    });
    if (existing && existing.status !== 'REMOVED') {
      throw new BadRequestException('This beneficiary is already saved');
    }
    if (existing) {
      return this.prisma.beneficiary.update({
        where: { id: existing.id },
        data: {
          beneficiaryName: params.beneficiaryName,
          bankName: params.bankName,
          bankCode: params.bankCode,
          nickname: params.nickname,
          status: 'ACTIVE',
          addedAt: new Date(),
          removedAt: null,
        },
      });
    }
    return this.prisma.beneficiary.create({
      data: {
        customerId: params.customerId,
        beneficiaryName: params.beneficiaryName,
        accountNumber: params.accountNumber,
        bankName: params.bankName,
        bankCode: params.bankCode,
        nickname: params.nickname,
        status: 'ACTIVE',
      },
    });
  }

  async remove(id: string, customerId: string) {
    await this.findOneForCustomer(id, customerId);
    return this.prisma.beneficiary.update({ where: { id }, data: { status: 'REMOVED', removedAt: new Date() } });
  }

  /**
   * CONFIRMED LIVE BUG FIX (2026-09-22, real-call review): Qwen called create_transfer with
   * beneficiary_id "ben_****981" — a plausible-looking but entirely invented ID, not the real
   * cuid from a prior get_beneficiaries result — so the transfer failed with "Beneficiary not
   * found" even though the customer genuinely had a saved, active beneficiary by that name. Same
   * failure family, same fix pattern, as AccountsService/CardsService.resolveForCustomer
   * (documented in this project's own prior fix for card/account ID hallucination) — just never
   * applied to beneficiaries until now. Tries the given ID first; if it doesn't resolve to a
   * real, owned beneficiary, falls back to matching the given NAME against the customer's own
   * saved list (case-insensitive substring, same as a human agent reading a name back) rather
   * than failing outright — the common case (customer names someone by their real saved name) has
   * nothing left to hallucinate. Ambiguous (2+ matches) or no match at all still fails safely,
   * exactly as before.
   */
  async resolveForCustomer(customerId: string, beneficiaryId?: string, beneficiaryName?: string) {
    if (beneficiaryId) {
      const byId = await this.prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
      if (byId && byId.customerId === customerId && byId.status !== 'REMOVED') {
        return byId;
      }
    }
    if (beneficiaryName) {
      const candidates = await this.findForCustomer(customerId);
      const needle = beneficiaryName.trim().toLowerCase();
      const matches = candidates.filter(
        (b) => b.beneficiaryName.toLowerCase().includes(needle) || (b.nickname ?? '').toLowerCase().includes(needle),
      );
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new BadRequestException(`Multiple saved beneficiaries match "${beneficiaryName}" — ask which one they mean`);
      }
    }
    throw new NotFoundException(
      beneficiaryName ? `No saved beneficiary matching "${beneficiaryName}"` : `Beneficiary ${beneficiaryId ?? ''} not found`,
    );
  }
}
