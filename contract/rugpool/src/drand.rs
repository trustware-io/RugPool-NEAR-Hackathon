//! Verifies drand quicknet beacons with NEAR's BLS12-381 host functions, so the draw's
//! randomness comes from outside the chain: no block producer, keeper or owner can know or
//! pick it before the round is published.
//!
//! Quicknet (`bls-unchained-g1-rfc9380`) signs `sha256(round as big-endian u64)` with a
//! threshold key: the signature is in G1, the public key in G2, and the round's randomness is
//! `sha256(signature)`. A round's signature is unique, so whoever submits it can't choose it.

use near_sdk::env;

/// The quicknet group public key (G2, compressed). Fixed: no method can replace it.
const QUICKNET_PK: [u8; 96] = hex96("83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a");
/// The G2 generator, compressed.
const G2_GEN: [u8; 96] = hex96("93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8");
const DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
/// Quicknet genesis, in ms, and its period.
pub const GENESIS_MS: u64 = 1_692_803_367_000;
pub const PERIOD_MS: u64 = 3_000;

/// The field modulus p, as big-endian 64-bit limbs.
const P: [u64; 6] = [
    0x1a0111ea397fe69a,
    0x4b1ba7b6434bacd7,
    0x64774b84f38512bf,
    0x6730d2a0f6b0f624,
    0x1eabfffeb153ffff,
    0xb9feffffffffaaab,
];

const fn hex96(s: &str) -> [u8; 96] {
    let b = s.as_bytes();
    let mut out = [0u8; 96];
    let mut i = 0;
    while i < 96 {
        match (nibble(b[2 * i]), nibble(b[2 * i + 1])) {
            (Some(hi), Some(lo)) => out[i] = (hi << 4) | lo,
            _ => panic!("not hex"),
        }
        i += 1;
    }
    out
}

const fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Hex to bytes; None if it isn't an even number of hex digits.
pub fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(2) {
        return None;
    }
    b.chunks(2).map(|p| Some((nibble(p[0])? << 4) | nibble(p[1])?)).collect()
}

/// The first round published at or after `ms`.
pub fn round_at(ms: u64) -> u64 {
    (ms.saturating_sub(GENESIS_MS)).div_ceil(PERIOD_MS) + 1
}

/// The round's randomness if `signature` (48 bytes, compressed G1) is quicknet's signature
/// for `round`; None otherwise.
pub fn verify(round: u64, signature: &[u8]) -> Option<[u8; 32]> {
    if signature.len() != 48 {
        return None;
    }
    let msg = env::sha256_array(round.to_be_bytes());
    let h = hash_to_g1(&msg);
    let sig = env::bls12381_p1_decompress(signature);
    // e(-sig, g2) · e(H(m), pk) == 1  ⇔  e(sig, g2) == e(H(m), pk)
    let mut neg = Vec::with_capacity(97);
    neg.push(1);
    neg.extend_from_slice(&sig);
    let neg_sig = env::bls12381_p1_sum(&neg);
    let mut pairs = Vec::with_capacity(2 * 288);
    pairs.extend_from_slice(&neg_sig);
    pairs.extend_from_slice(&env::bls12381_p2_decompress(G2_GEN));
    pairs.extend_from_slice(&h);
    pairs.extend_from_slice(&env::bls12381_p2_decompress(QUICKNET_PK));
    env::bls12381_pairing_check(&pairs).then(|| env::sha256_array(signature))
}

/// RFC 9380 `hash_to_curve` for G1 with SHA-256: two field elements, each mapped to the curve
/// (the host function also clears the cofactor), then added. Returns an uncompressed point.
fn hash_to_g1(msg: &[u8]) -> Vec<u8> {
    let uniform = expand_message_xmd(msg);
    let mut fps = [0u8; 96];
    fps[..48].copy_from_slice(&reduce(&uniform[..64]));
    fps[48..].copy_from_slice(&reduce(&uniform[64..]));
    let points = env::bls12381_map_fp_to_g1(fps);
    let mut sum = Vec::with_capacity(2 * 97);
    sum.push(0);
    sum.extend_from_slice(&points[..96]);
    sum.push(0);
    sum.extend_from_slice(&points[96..]);
    env::bls12381_p1_sum(&sum)
}

/// RFC 9380 `expand_message_xmd` for 128 bytes (two 64-byte field elements).
fn expand_message_xmd(msg: &[u8]) -> [u8; 128] {
    let mut dst_prime = DST.to_vec();
    dst_prime.push(DST.len() as u8);
    let mut m = vec![0u8; 64];
    m.extend_from_slice(msg);
    m.extend_from_slice(&[0, 128, 0]);
    m.extend_from_slice(&dst_prime);
    let b0 = env::sha256_array(&m);
    let mut out = [0u8; 128];
    let mut prev = [0u8; 32];
    for i in 0..4u8 {
        let mut input: Vec<u8> = if i == 0 { b0.to_vec() } else { b0.iter().zip(prev).map(|(a, b)| a ^ b).collect() };
        input.push(i + 1);
        input.extend_from_slice(&dst_prime);
        prev = env::sha256_array(&input);
        out[32 * i as usize..32 * (i as usize + 1)].copy_from_slice(&prev);
    }
    out
}

/// A 64-byte big-endian integer mod p, as 48 big-endian bytes. Shift-and-subtract, one bit at
/// a time: r stays below p, so 2r + 1 < 2^382 fits the six limbs.
fn reduce(x: &[u8]) -> [u8; 48] {
    let mut r = [0u64; 6];
    for byte in x {
        for bit in (0..8).rev() {
            let mut carry = u64::from((byte >> bit) & 1);
            for limb in r.iter_mut().rev() {
                let next = *limb >> 63;
                *limb = (*limb << 1) | carry;
                carry = next;
            }
            if !less_than_p(&r) {
                sub_p(&mut r);
            }
        }
    }
    let mut out = [0u8; 48];
    for (i, limb) in r.iter().enumerate() {
        out[8 * i..8 * i + 8].copy_from_slice(&limb.to_be_bytes());
    }
    out
}

fn less_than_p(r: &[u64; 6]) -> bool {
    for (a, b) in r.iter().zip(P) {
        if *a != b {
            return *a < b;
        }
    }
    false
}

fn sub_p(r: &mut [u64; 6]) {
    let mut borrow = 0u64;
    for (limb, p) in r.iter_mut().zip(P).rev() {
        let (d, b1) = limb.overflowing_sub(p);
        let (d, b2) = d.overflowing_sub(borrow);
        *limb = d;
        borrow = u64::from(b1 || b2);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    /// Quicknet round 33478462, fetched from api.drand.sh on 2026-10-28.
    pub(crate) const ROUND: u64 = 33_478_462;
    pub(crate) const SIG: &str = "8879131e59bccbe48a1c4b600518932bd1da47c50b31510d774ca1f4d72b07630a80f75fef655c5598105200d619e3ee";
    const RANDOMNESS: &str = "569225441d78ea15af5532749a3a5d6b101600cbc1a6c2e96a7fac44402b3dc1";

    fn unhex(s: &str) -> Vec<u8> {
        decode_hex(s).unwrap()
    }

    #[test]
    fn hash_to_g1_matches_a_reference_implementation() {
        testing_env!(VMContextBuilder::new().build());
        let msg = env::sha256_array(ROUND.to_be_bytes());
        // From @noble/curves 2.2.0: bls12_381.shortSignatures.hash(msg, DST), uncompressed.
        let expected = "0bf0604b5655bac24b1e1b5c23f135611cfffb6277e447d2f2dcde217c676abd5b417d12876f565f4ad201008f77a3771499080dc460f077cfe02abf467b516e97a7c0f58fee0ee62d45664da4528845d8a87aee252f79b2a6ef76658b19d2d6";
        assert_eq!(hash_to_g1(&msg), unhex(expected));
    }

    #[test]
    fn a_real_quicknet_round_verifies() {
        testing_env!(VMContextBuilder::new().build());
        assert_eq!(verify(ROUND, &unhex(SIG)).map(|r| r.to_vec()), Some(unhex(RANDOMNESS)));
    }

    #[test]
    fn the_signature_only_verifies_for_its_own_round() {
        testing_env!(VMContextBuilder::new().build());
        assert_eq!(verify(ROUND + 1, &unhex(SIG)), None);
        assert_eq!(verify(ROUND - 1, &unhex(SIG)), None);
    }

    #[test]
    fn altered_encodings_never_verify() {
        // Cleared compression flag, set infinity flag, flipped sign, truncated: each must fail
        // (a host-function error aborts the call; a well-formed wrong point fails the pairing).
        let sig = unhex(SIG);
        let mut variants = vec![sig[..47].to_vec()];
        for mask in [0x80u8, 0x40, 0x20] {
            let mut v = sig.clone();
            v[0] ^= mask;
            variants.push(v);
        }
        for v in variants {
            testing_env!(VMContextBuilder::new().build());
            let r = std::panic::catch_unwind(|| verify(ROUND, &v));
            assert!(matches!(r, Err(_) | Ok(None)), "{v:02x?} verified");
        }
    }

    #[test]
    fn reduce_matches_known_values() {
        // p itself reduces to zero; p - 1 stays; 2^512 - 1 mod p from Python.
        let mut p = [0u8; 64];
        for (i, limb) in P.iter().enumerate() {
            p[16 + 8 * i..24 + 8 * i].copy_from_slice(&limb.to_be_bytes());
        }
        assert_eq!(reduce(&p), [0u8; 48]);
        p[63] -= 1;
        assert_eq!(reduce(&p)[..], p[16..]);
        let max = reduce(&[0xff; 64]);
        assert_eq!(max.to_vec(), unhex(MAX_MOD_P));
    }

    const MAX_MOD_P: &str = "02cb5d3a884e56c4fab7cd07ee4e16bc15efebb5d396d7cf82383087033108464532383fa8eaff4e967d3988a62b6c9c";

    #[test]
    fn round_at_is_the_first_round_at_or_after() {
        assert_eq!(round_at(GENESIS_MS), 1);
        assert_eq!(round_at(GENESIS_MS + 1), 2);
        assert_eq!(round_at(GENESIS_MS + PERIOD_MS), 2);
        assert_eq!(round_at(GENESIS_MS + PERIOD_MS + 1), 3);
    }
}
