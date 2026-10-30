package com.dha.harness;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;

/** Generates the v2 Sec-MS-GEC token used by Microsoft Edge read aloud. */
final class EdgeToken {
    private static final String TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final long WINDOWS_EPOCH_SECONDS = 11_644_473_600L;
    private static final long U32 = 0xFFFFFFFFL;

    private static final int[] SHA256_INITIAL = {
            0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
            0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19
    };
    private static final int[] SHA256_STATE = {
            0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
            0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2
    };
    private static final int[] SHA256_SCHEDULE = {
            0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
            0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
            0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
            0xD258B060, 0x72766564
    };
    private static final int[] SHA256_ROUND = {
            0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
            0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
            0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
            0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
            0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC,
            0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
            0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
            0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
            0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
            0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
            0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3,
            0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
            0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5,
            0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
            0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
            0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
    };
    private static final int SHA256_ADJUSTMENT = 0xC9DC06A7;
    private static final int SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80;
    private static final int SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0;

    private static final int[] CS64_COEFFICIENTS = {
            0xE82E91B1, 0x44DE24C6, 0x3BEB65BC, 0xC89C5933,
            0x8D1EC211, 0x314EF5D5, 0xE92491B1, 0xF0A5B9D5,
            0x06064CF3, 0xDA79FA60, 0xBED20560, 0x89F9C9F8,
            0x35FA38C6, 0xCB49E3C6
    };
    private static final int[] CS64_OFFSETS = {
            0xB32700D0, 0x88DFF51D, 0x29514038, 0xB328CBDF,
            0xD405B4D5, 0x26E55F3C, 0x607801C6, 0x82B2C1FB,
            0xFA51A3DA, 0x207CC464, 0x3C3C74F3, 0xD2D14B61,
            0xBB04A2C1, 0xC5626167
    };
    private static final long CS64_FACTOR = 0x82893933L;
    private static final long CS64_ADJUSTMENT0 = 0xF2F90B1AL;
    private static final long CS64_ADJUSTMENT1 = 0x0B1A0000L;

    private EdgeToken() {
    }

    static String current() {
        return forUnixSeconds(System.currentTimeMillis() / 1000L);
    }

    static String forUnixSeconds(long unixSeconds) {
        long ticks = unixSeconds + WINDOWS_EPOCH_SECONDS;
        ticks -= Math.floorMod(ticks, 300L);
        ticks *= 10_000_000L;
        byte[] input = (ticks + TRUSTED_CLIENT_TOKEN).getBytes(StandardCharsets.US_ASCII);
        byte[] digest = sha256Digest(input);
        int[] cs64 = cs64Digest(input, digest);
        return wordLeHex(cs64[0]) + wordLeHex(cs64[1]) + "-" + hex(digest);
    }

    private static byte[] sha256Digest(byte[] data) {
        if (data.length < 7) throw new IllegalArgumentException("Token salt too short");
        int length = 57 + data.length;
        int zeroCount = Math.floorMod(55 - length, 64);
        ByteArrayOutputStream padded = new ByteArrayOutputStream();
        padded.write(data, 7, data.length - 7);
        padded.write(0x80);
        padded.writeBytes(new byte[zeroCount]);
        long bitLength = length * 8L;
        for (int shift = 56; shift >= 0; shift -= 8) {
            padded.write((int) (bitLength >>> shift) & 0xff);
        }

        int[] state = sha256Init(Arrays.copyOfRange(data, 0, 7));
        byte[] block = padded.toByteArray();
        for (int offset = 0; offset < block.length; offset += 64) {
            int[] words = new int[64];
            for (int index = 0; index < 16; index++) {
                int position = offset + index * 4;
                words[index] = ((block[position] & 0xff) << 24)
                        | ((block[position + 1] & 0xff) << 16)
                        | ((block[position + 2] & 0xff) << 8)
                        | (block[position + 3] & 0xff);
            }
            expandSchedule(words, 16);
            int[] working = sha256Rounds(state, words, 0);
            for (int index = 0; index < state.length; index++) {
                state[index] += working[index];
            }
        }

        byte[] digest = new byte[32];
        for (int index = 0; index < state.length; index++) {
            int value = state[index];
            digest[index * 4] = (byte) (value >>> 24);
            digest[index * 4 + 1] = (byte) (value >>> 16);
            digest[index * 4 + 2] = (byte) (value >>> 8);
            digest[index * 4 + 3] = (byte) value;
        }
        return digest;
    }

    private static int[] sha256Init(byte[] prefix) {
        int[] words = new int[64];
        words[14] = ((prefix[0] & 0xff) << 16)
                | ((prefix[1] & 0xff) << 8)
                | (prefix[2] & 0xff);
        words[15] = ((prefix[3] & 0xff) << 24)
                | ((prefix[4] & 0xff) << 16)
                | ((prefix[5] & 0xff) << 8)
                | (prefix[6] & 0xff);
        for (int index = 16; index <= 29; index++) {
            int value = SHA256_SCHEDULE[index - 16];
            if (index - 2 >= 14) {
                int sigma = smallSigma1(words[index - 2]);
                value += index == 16 ? sigma ^ SHA256_SIGMA1_ADJUSTMENT : sigma;
            }
            if (index - 7 >= 14) value += words[index - 7];
            if (index - 15 >= 14) {
                int sigma = smallSigma0(words[index - 15]);
                value += index == 29 ? sigma ^ SHA256_SIGMA0_ADJUSTMENT : sigma;
            }
            words[index] = value;
        }
        words[30] = smallSigma1(words[28])
                + words[23]
                + smallSigma0(words[15])
                + words[14]
                + SHA256_ADJUSTMENT
                - SHA256_ROUND[14];
        expandSchedule(words, 31);
        int[] working = sha256Rounds(SHA256_STATE, words, 14);
        int[] state = new int[8];
        for (int index = 0; index < state.length; index++) {
            state[index] = SHA256_INITIAL[index] + working[index];
        }
        return state;
    }

    private static int[] sha256Rounds(int[] source, int[] words, int firstRound) {
        int a = source[0];
        int b = source[1];
        int c = source[2];
        int d = source[3];
        int e = source[4];
        int f = source[5];
        int g = source[6];
        int h = source[7];
        for (int index = firstRound; index < 64; index++) {
            int round = index == 14 && firstRound == 14 ? SHA256_ADJUSTMENT : SHA256_ROUND[index];
            int t1 = h
                    + (Integer.rotateRight(e, 6)
                    ^ Integer.rotateRight(e, 11)
                    ^ Integer.rotateRight(e, 25))
                    + (g ^ (e & (f ^ g)))
                    + round
                    + words[index];
            int t2 = (Integer.rotateRight(a, 2)
                    ^ Integer.rotateRight(a, 13)
                    ^ Integer.rotateRight(a, 22))
                    + ((a & b) | (c & (a | b)));
            h = g;
            g = f;
            f = e;
            e = d + t1;
            d = c;
            c = b;
            b = a;
            a = t1 + t2;
        }
        return new int[]{a, b, c, d, e, f, g, h};
    }

    private static void expandSchedule(int[] words, int firstWord) {
        for (int index = firstWord; index < 64; index++) {
            words[index] = smallSigma1(words[index - 2])
                    + words[index - 7]
                    + smallSigma0(words[index - 15])
                    + words[index - 16];
        }
    }

    private static int smallSigma0(int value) {
        return Integer.rotateRight(value, 7)
                ^ Integer.rotateRight(value, 18)
                ^ (value >>> 3);
    }

    private static int smallSigma1(int value) {
        return Integer.rotateRight(value, 17)
                ^ Integer.rotateRight(value, 19)
                ^ (value >>> 10);
    }

    private static int[] cs64Digest(byte[] data, byte[] digest) {
        ByteBuffer digestBuffer = ByteBuffer.wrap(digest).order(ByteOrder.LITTLE_ENDIAN);
        int keyA = digestBuffer.getInt(0) | 1;
        int keyB = digestBuffer.getInt(4) | 1;
        int factorA = multiply(keyA, CS64_FACTOR);
        int factorB = multiply(keyB, CS64_FACTOR);
        int[] words = wordsLe4Even(data);
        int[] terms = new int[CS64_COEFFICIENTS.length + words.length];
        int[] offsets = new int[terms.length];
        for (int index = 0; index < CS64_COEFFICIENTS.length; index++) {
            terms[index] = multiply(CS64_COEFFICIENTS[index],
                    index % 2 == 0 ? factorA : factorB);
            offsets[index] = CS64_OFFSETS[index];
        }
        for (int index = 0; index < words.length; index++) {
            int term = multiply(words[index], index % 2 == 0 ? keyA : keyB);
            int offset = multiply(Integer.rotateLeft(words[index], 16),
                    index % 2 == 0 ? 0xEF0569FBL : 0xC31713DBL);
            if (index == 0) {
                term += multiply((int) CS64_ADJUSTMENT0, factorA);
                offset += CS64_ADJUSTMENT1;
            }
            terms[CS64_COEFFICIENTS.length + index] = term;
            offsets[CS64_COEFFICIENTS.length + index] = offset;
        }

        int swapAccumulator = 0;
        int swapLast = 0;
        int state = 0;
        int accumulator = 0;
        for (int index = 0; index < terms.length; index += 2) {
            int rotated = Integer.rotateLeft(offsets[index] + terms[index], 16);
            int product = multiply(rotated, 0x76F50F34L);
            swapAccumulator += multiply(Integer.rotateLeft(product, 16), 0xC3EFEA97L)
                    + product;

            rotated = Integer.rotateLeft(offsets[index + 1] + terms[index + 1], 16);
            product = multiply(rotated, 0x1881CE3CL);
            swapLast = multiply(Integer.rotateLeft(product, 16), 0x35BD1EC9L) + product;
            swapAccumulator += swapLast;

            state = multiply(state, keyA) + terms[index];
            state = multiply(Integer.rotateLeft(state, 16), 0xCF98B111L);
            state = multiply(Integer.rotateLeft(state, 16), 0x87085B9FL);
            state = multiply(Integer.rotateLeft(state, 16), 0x12CEB96DL);
            state = multiply(Integer.rotateLeft(state, 16), 0x257E1D83L);
            accumulator += state;

            rotated = multiply(state, keyB) + terms[index + 1];
            rotated = multiply(Integer.rotateLeft(rotated, 16), 0xA27416F5L);
            rotated = multiply(Integer.rotateLeft(rotated, 16), 0xD38396FFL);
            state = multiply(Integer.rotateLeft(
                    multiply(Integer.rotateLeft(rotated, 16), 0x7C932B89L), 16),
                    0xBFA49F69L);
            accumulator += state;
        }
        return new int[]{swapLast ^ state, swapAccumulator ^ accumulator};
    }

    private static int[] wordsLe4Even(byte[] source) {
        byte[] data = new byte[source.length + 1];
        System.arraycopy(source, 0, data, 1, source.length);
        int paddedLength = (data.length + 3) & ~3;
        int count = paddedLength / 4;
        int[] words = new int[count + (count & 1)];
        for (int index = 0; index < count; index++) {
            int position = index * 4;
            int b0 = position < data.length ? data[position] & 0xff : 0;
            int b1 = position + 1 < data.length ? data[position + 1] & 0xff : 0;
            int b2 = position + 2 < data.length ? data[position + 2] & 0xff : 0;
            int b3 = position + 3 < data.length ? data[position + 3] & 0xff : 0;
            words[index] = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
        }
        return words;
    }

    private static int multiply(int value, long factor) {
        return (int) (((value & U32) * factor) & U32);
    }

    private static String wordLeHex(int value) {
        StringBuilder result = new StringBuilder(8);
        for (int index = 0; index < 4; index++) {
            result.append(String.format(Locale.US, "%02X", (value >>> (index * 8)) & 0xff));
        }
        return result.toString();
    }

    private static String hex(byte[] data) {
        StringBuilder result = new StringBuilder(data.length * 2);
        for (byte item : data) {
            result.append(String.format(Locale.US, "%02X", item & 0xff));
        }
        return result.toString();
    }
}
