package com.lym.spend.sms

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SpendSmsAutoParserTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext

  @Test
  fun paymentRequestsAreNonSpend() {
    listOf(
      "initiate the payment process for your purchased item please click on the outlined payment link Rs.8900",
      "Your order is confirmed. Please complete payment of Rs.8900 by clicking the link below",
      "Pay now Rs.4999 to claim your reward. Click bit.ly/xyz",
      "Payment pending for order #123. Amount due Rs.2500",
    ).forEach { message ->
      val result = SpendSmsAutoParser.parse(context, "TEST", message, 0L)
      assertEquals(message, SmsMessageClassification.PAYMENT_REQUEST, result.classification)
      assertNull(message, result.transaction)
    }
  }

  @Test
  fun completedDebitConstructionsRemainTransactions() {
    listOf(
      "Sent Rs.48.00 from XXXXXX1234 to RAHUL SHARMA on 01/06/2026. UPI ref no. 651805890728." to 4_800L,
      "Payment of Rs.1,200 to SWIGGY is successful. UPI Ref 123456789012." to 120_000L,
      "Avl Bal Rs.12,345 in A/c X1234 after debit of Rs.500." to 50_000L,
    ).forEach { (message, expectedAmount) ->
      val result = SpendSmsAutoParser.parse(context, "TEST", message, 0L)
      assertEquals(message, SmsMessageClassification.POSTED_DEBIT, result.classification)
      assertEquals(message, expectedAmount, result.transaction?.amountMinor)
    }
  }

  @Test
  fun creditLimitPromotionRemainsNonSpend() {
    val result = SpendSmsAutoParser.parse(
      context,
      "TEST",
      "Get upto 8 PVR INOX tickets on ... Credit Card. Limit Rs. 90000",
      0L,
    )
    assertEquals(SmsMessageClassification.MARKETING, result.classification)
    assertNull(result.transaction)
  }
}
